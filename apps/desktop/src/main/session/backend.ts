import {
  keysPresent,
  loadConfig,
  resolveKeys,
  secretDirsFor,
  type ProjectConfig,
} from '@vn/config';
import { openGit } from '@vn/git';
import { ConfigError } from '@vn/util';
import { catalogProps } from '@vn/commands';
import { estimateSentence } from '@vn/gengraph';
import { slotLabel } from '@vn/stills';
import { ProjectPaths } from '@vn/store';
import { chatBackendFor, chatRoute } from '@vn/providers';
import {
  API_RETRIES,
  Agent,
  NativeAgentBackend,
  StructuredAgentBackend,
  Workspace,
  apiRecoveryQuestion,
  createRegistry,
  historyTools,
  joinSections,
  loadContext,
  readApiPlan,
  workspaceArtGen,
  workspaceTextLLM,
  type AgentBackend,
  type AgentEvent,
  type ApiFailure,
  type ApiRecovery,
  type HistoryReader,
  type Tool,
  type ToolContext,
} from '@vn/authoring';
import { TEXT_MODELS, chatRouteFor, type Route, type Transport } from '@vn/types';
import { BUSY_PASS, BUSY_RUN } from '../../shared/ipc.js';
import { TRANSPORTS, continuingTransport, narrowedTo } from '../../shared/threads.js';
import { received } from '../../shared/convo.js';
import { createDesktopInteractions } from '../../shared/interactions.js';
import { createDesktopRegistry } from '../commands/index.js';
import { builtinSkillsDir, UX_DOCS_PATH, uxDocsDir } from '../distribution/resources.js';
import { appSections, showMeTool } from '../agent/showme.js';
import { uxCheckTool, uxDocsTools } from '../agent/uxdocs.js';
import { notify } from '../notify/notifications.js';
import { readNative } from '../notify/threads.js';
import { MockAgentBackend } from './rules/agent.js';
import type { WorkspaceSession } from './core.js';

/** Builds the agent and its backend, and answers a failed model call on the author's behalf. */
export class BackendPart {
  constructor(private readonly session: WorkspaceSession) {}

  /**
   * The backend for the next turn. A chat backend that can hold a conversation gets the native
   * backend, which is the cached path. Every other backend gets the text path.
   *
   * The probe is `chatConversation` and deliberately not `chatWithTools`: Gemini implements the
   * latter, and moving it onto the native path would give it a larger tools block for a request
   * that is still single-shot and still caches nothing.
   */

  async buildBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    const backend = await this.chooseBackend(config, model);
    // Kept here because `Agent` does not expose the backend it was handed, and the native log has
    // to record which protocol its messages are in for a later resume to refuse the wrong one.
    this.session.native.kind = backend.kind;
    return backend;
  }

  async chooseBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    if (this.session.mock) return new MockAgentBackend();
    const modelId = model ?? config.models.text;
    const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(this.session.dir) });
    const pin = this.session.native.opened ? this.session.native.transport : undefined;
    let route: Route;
    if (pin === undefined) {
      route = chatRoute(config, keys, modelId);
    } else {
      const pinned = chatRouteFor(modelId, narrowedTo(pin, keysPresent(keys)));
      if (!pinned) {
        throw new ConfigError(
          `This conversation was recorded through ${TRANSPORTS[pin]}, and no key for it ` +
            'resolves now. Provide one, or open the conversation for reading.',
        );
      }
      route = pinned;
    }
    this.session.native.transport = route.transport;
    const chat = chatBackendFor(route, keys, this.session.effort).backend;
    return chat.chatConversation ? new NativeAgentBackend(chat) : new StructuredAgentBackend(chat);
  }

  /** What a resume binding is checked against: see {@link continuingTransport}. */
  async continuingTransport(
    config: ProjectConfig,
    recorded: Transport | undefined,
  ): Promise<Transport | undefined> {
    if (this.session.mock || this.session.model === '') return undefined;
    const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(this.session.dir) });
    return continuingTransport(this.session.model, keysPresent(keys), recorded);
  }

  /**
   * The history `search_history` and `read_history` read: the open conversation's native log,
   * which keeps every message a compaction replaced. It is resolved per call rather than captured,
   * because the agent outlives the thread that is open in it, and a thread that has not been
   * written yet has nothing to search.
   */

  history(): HistoryReader {
    return {
      messages: async () => {
        const id = this.session.thread?.id;
        if (!id) return [];
        const log = await readNative(new ProjectPaths(this.session.dir), id).catch(() => undefined);
        return log?.messages ?? [];
      },
    };
  }

  async ensureAgent(): Promise<Agent> {
    if (this.session.agent) return this.session.agent;
    const workspace = new Workspace(this.session.dir);
    const builtin = builtinSkillsDir();
    const ctx: ToolContext = {
      workspace,
      ...(builtin ? { builtinSkillsDir: builtin } : {}),
      git     : openGit(this.session.dir),
      // Read at commit time: the thread opens on the turn's first message, after the agent is built
      trailers: (): Record<string, string> =>
        this.session.thread ? { 'Vn-Thread': this.session.thread.id } : {},
      // Called from inside the agent's own turn, so only a pipeline run or pass counts as busy
      busy    : () => [BUSY_RUN, BUSY_PASS].find((what) => this.session.running(what)),
      // The agent's `generate_image` and the palette's `art.generate` draw the same picture; the
      // session's own `mock` is the only policy about whether it is real art.
      art     : workspaceArtGen(workspace, { mock: this.session.mock }),
      text    : workspaceTextLLM(workspace, { mock: this.session.mock }),
      // Approval is authorized by the author's own words, so this seam carries the model that
      // reads them alongside the two acts it gates.
      approval: {
        list     : () => this.session.approvable(),
        approve  : (item) => this.session.approveOne(item),
        approved : () => this.session.approvedAssets(),
        unapprove: (item) => this.session.unapproveOne(item),
        triage   : () => this.session.gatePart.triageBackend(),
      },
      // The capability `vnauthor` does not have: the same two calls `asset.regenerate` makes, so
      // an agent-started re-render takes the busy flag a pipeline run takes.
      pipeline: {
        regenerate: (hash) => this.session.regenerateAsset(hash),
        run: async () => {
          const result = await this.session.runPipeline(this.session.mock);
          return { ran: result.ran, failed: result.failed, blockedOnGate: result.blockedOnGate };
        },
      },
      // Reading and editing a graph need no host, so only the run is wired here. It is the same
      // pair of calls `gengraph.run` makes, priced by the same sentence the author confirms.
      graphs: {
        estimate: async (slug) => {
          // Asked before the estimate so a run whose take could not be filed is refused before
          // the author is quoted a price for it
          const planned = await this.session.runTarget(slug);
          if (!planned.ok) return { ok: false, reason: planned.reason };
          const counted = await this.session.graphEstimate(slug);
          if (!counted.ok) return { ok: false, reason: counted.reason };
          const files =
            planned.slot === undefined
              ? ''
              : ` The picture it ends on becomes the ${slotLabel(planned.slot)}, waiting for approval.`;
          return { ok: true, note: `${estimateSentence(counted.estimate, counted.stale)}${files}` };
        },
        run: (slug, opts) =>
          this.session.runGraph(slug, { force: opts.force, mock: this.session.mock }),
      },
    };
    const context = await loadContext(this.session.dir);
    const config = await loadConfig(this.session.dir);
    this.session.model = config.models.text;
    // A dev launch that skipped the generator says so here, once, rather than shipping an agent
    // whose `show_me` points at pages that are not there
    const uxDocs = uxDocsDir();
    if (uxDocs === undefined) {
      console.warn(`[vnstudio] no UX docs tree at ${UX_DOCS_PATH}; the agent has no ux_* tools`);
    }
    this.session.agent = new Agent({
      backend: await this.buildBackend(config),
      ctx,
      registry: createRegistry([
        ...historyTools(this.history()),
        ...(uxDocs === undefined ? [] : uxDocsTools(uxDocs)),
        ...(this.session.deps.checkCommand === undefined
          ? []
          : [
              uxCheckTool({
                check: this.session.deps.checkCommand.bind(this.session.deps),
                props: (id) => {
                  const command = createDesktopRegistry().get(id);
                  return command === undefined ? undefined : catalogProps(command.props);
                },
              }) as Tool,
            ]),
        showMeTool({
          ...(this.session.deps.showTour
            ? { show: this.session.deps.showTour.bind(this.session.deps) }
            : {}),
          commands    : createDesktopRegistry(),
          interactions: createDesktopInteractions(),
          pages       : uxDocs !== undefined,
        }) as Tool,
      ]),
      permission: this.session.permission(),
      system    : joinSections(appSections(context)),
      budget    : this.session.budget,
      onEvent: (event) => {
        this.session.record((convo) => received(convo, event));
        if (event.type === 'usage') this.session.recordUsage(event);
        this.session.deps.emitEvent(event);
        if (event.type === 'api') this.announceApi(event);
      },
      onApiError: (failure) => this.recoverApi(failure),
      onMessage : (message) => this.session.recordMessage(message),
    });
    return this.session.agent;
  }

  /**
   * A call to the model failed. This asks the author once what can be done about it. The
   * author's answer buys a grant of attempts, and the loop spends that grant without asking
   * again.
   *
   * A second failure after the grant is spent does not ask again, because the author already
   * chose a recovery and it did not work, so re-offering the same three options would just
   * repeat the question. The turn ends instead. The conversation stays intact, so resending it
   * takes one keystroke.
   */

  async recoverApi(failure: ApiFailure): Promise<ApiRecovery> {
    if (failure.attempt > 1) return { do: 'stop' };
    // Offer every curated model except the one that just failed — switching to the failed model
    // would retry the same request against the same backend.
    const others = TEXT_MODELS.filter((id) => id !== this.session.model);
    const question = apiRecoveryQuestion(failure, this.session.model, others);
    const [answer = ''] = await this.session.deps.requestAnswer([question]);
    const plan = readApiPlan(answer, others);
    if (plan.do === 'switch') {
      // Before the retry rather than after it: the loop re-reads the backend every attempt, so a
      // model swapped here is the one the next attempt is made against. It gets one try, so a
      // model the author picked that also fails is reported rather than retried repeatedly.
      await this.session.setModel(plan.model);
      return { do: 'retry', times: 1 };
    }
    if (plan.do === 'report') {
      // The turn ends either way: a diagnosis reads the request that failed, and another attempt
      // would only put a second one in front of it.
      this.session.deps.offerDiagnosis?.({
        ...(this.session.thread ? { thread: this.session.thread.id } : {}),
        message: failure.message,
      });
      return { do: 'stop' };
    }
    return plan.do === 'retry' ? { do: 'retry', times: API_RETRIES } : { do: 'stop' };
  }

  /**
   * File a notification for how an API failure resolved. Only the two terminal outcomes
   * (recovered, gave up) are filed: retries in flight are shown by the header's counter, and a
   * durable record per attempt would bury the one line that says how it came out.
   */

  announceApi(event: Extract<AgentEvent, { type: 'api' }>): void {
    const tries = (n: number): string => `${n} failed attempt${n === 1 ? '' : 's'}`;
    if (event.phase === 'recovered') {
      void notify({
        category: 'agent',
        source  : 'agent',
        message : `The model answered after ${tries(event.attempt)}.`,
      });
    } else if (event.phase === 'gaveup') {
      void notify({
        category: 'error',
        level   : 'error',
        source  : 'agent',
        message : `Gave up on the model after ${tries(event.attempt)}: ${event.message}`,
      });
    }
  }
}
