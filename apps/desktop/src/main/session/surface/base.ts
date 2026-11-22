import { ProjectPaths } from '@vn/store';
import { chatVendorFor } from '@vn/providers';
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  BackendKind,
  Permission,
  SystemSection,
  Workspace,
} from '@vn/authoring';
import type { EffortChoice } from '@vn/types';
import { DEFAULT_BUDGET, DEFAULT_AGENT_EFFORT, type BudgetChoice, type Transport } from '@vn/types';
import type { Analyst, Redactor } from '@vn/agentreport';
import { BUSY_AGENT, BUSY_PASS, BUSY_REPORT, busyName } from '../../../shared/ipc.js';
import type { BusyProgress, GraphDocRead, GroupDocRead, ReportRow } from '../../../shared/ipc.js';
import type { GraphSlug } from '../../doctree/graphs.js';
import { confirmDetail } from '../../agent/toolconfirm.js';
import {
  answeredQuestion,
  decided,
  emptyConvo,
  proposed,
  queried,
  type Convo,
  type ThreadUsage,
} from '../../../shared/convo.js';
import {
  NATIVE_VERSION,
  appendItem,
  appendNative,
  appendUsage,
  type NativeLine,
  type ThreadHeader,
} from '../../notify/threads.js';
import type { AnalysisParts, AnalysisRequest, Transcript } from '../../agent/agentreport.js';
import type { SessionDeps } from '../types/deps.js';
import type { HeldDoc } from '../load/held.js';

/**
 * The state a workspace session holds and the substrate every surface leans on: what is in
 * flight, the permission hooks, and the writes to the conversation's two logs. The delegating
 * surfaces extend this in a chain that ends at `WorkspaceSession`.
 */
export abstract class SessionBase {
  agent: Agent | undefined;
  /**
   * One `Workspace` for this session, so its story bible is opened once.
   *
   * Only the bible handle survives between calls. `Workspace.load()` holds nothing, so every
   * method here still re-reads the authored input a command may just have written — what is saved
   * is the full `wiki/` walk that opening a bible performs, which `refresh()` then keeps current
   * by re-reading only the files whose mtime moved.
   */
  heldWorkspace: Workspace | undefined;
  /** The text model the agent is bound to (what a future `/model` would report). */
  model = '';
  /** The reasoning effort the backend is built with. Always an explicit value, so the app never
   * silently inherits a vendor default. */
  effort: EffortChoice = DEFAULT_AGENT_EFFORT;
  /**
   * Caps the non-cached tokens a single turn may spend. Unlike the model and the effort, this
   * is not something the backend is built with; it is the loop's own meter, so setting it
   * rebuilds nothing and works under `--mock` like anything else the loop decides.
   */
  budget: BudgetChoice = DEFAULT_BUDGET;

  /** What long-running work is in flight, by name; empty when the session is idle. */
  readonly inFlight = new Set<string>();
  /** How the work above is going, as the scheduler last reported it. Zeroed when it ends. */
  progress: BusyProgress = { ran: 0, pending: 0 };
  /**
   * Set for as long as generative work is interruptible; `stopPipeline` is the one caller. A pass
   * holds one for all of its rounds, and the runs inside it share that one rather than making
   * their own.
   */
  cancel: AbortController | undefined;
  /**
   * Set for as long as a run has tasks that can be cut off; `abortPipeline` is the one caller.
   * One per run rather than per pass, since only a run has tasks in flight.
   */
  abortTasks: AbortController | undefined;

  /**
   * The conversation as main sees it, reduced by the functions the renderer runs — so what is
   * written down and what is on screen are derived from one definition rather than two.
   */
  convo: Convo = emptyConvo('');
  /** The thread being written to. Opened by the first turn, never by opening the app. */
  thread: ThreadHeader | undefined;
  /**
   * The native log's state for the open thread: which protocol the backend speaks, the sections
   * the next header line will carry, how many messages have been appended, whether that header has
   * been written yet, and how far a compaction has covered.
   */
  native = {
    kind       : 'mock' as BackendKind,
    sections   : [] as SystemSection[],
    n          : 0,
    opened     : false,
    /**
     * The key the open thread's messages go through. Set when the backend is built and written
     * into the header with the first message; once the header is written, `chooseBackend` keeps
     * the backend on it, because a rebuild (`setEffort`, a key pasted mid-thread) that moved the
     * thread to another transport would send messages in a format the model cannot read.
     */
    transport  : undefined as Transport | undefined,
    /** The highest `n` the newest summary replaces. Undefined until the author compacts. */
    compactedTo: undefined as number | undefined,
  };
  /**
   * Ids for the plan and question cards main reduces for the transcript. They are inert here —
   * the card the author clicks is the renderer's — but the reducers are shared, so they are given
   * distinct ones rather than a repeated zero.
   */
  cardSeq = 1;
  /**
   * Whether the project map is owed a rewrite before the next turn reads it. True to begin with,
   * because a workspace that was never mapped is the common case — `examples/test4` has no
   * `AICONTEXT.generated.md` and never did, so every thread re-derived the cast from searches.
   */
  mapStale = true;
  /**
   * Appends, in order. Half the calls that add a transcript line happen inside a synchronous
   * `onEvent`, so the writes queue behind one promise instead of racing; `runAgent` waits it out
   * before returning, which is what makes the file complete the moment a turn is.
   */
  writes: Promise<void> = Promise.resolve();
  /**
   * Which API call the next receipt belongs to, counted from 1 and reset when a thread is opened.
   * A turn spends several calls, so a receipt needs an index of its own to be lined up against the
   * transcript without matching timestamps.
   */
  step = 1;
  /**
   * The redactor the last report was written with, kept so the leak scan runs against the same
   * pseudonym table rather than a freshly built one — a different table is a different set of
   * names, and the question being asked is whether this report still says one.
   */
  redaction: Redactor | undefined;
  /**
   * The debug conversation, while one is open. Held here for the reason {@link cancel} is: a stop
   * arrives from a command that is not the one running the turn it stops.
   */
  analyst: Analyst | undefined;
  /**
   * What the open debug conversation was assembled from. A grant made part way through builds its
   * tools against these, so it reads the evidence the conversation started with and spends the
   * budget the earlier turns have already drawn on.
   */
  analysis: { req: AnalysisRequest; parts: AnalysisParts; thread: ThreadHeader } | undefined;
  /** Every row of the open debug conversation, in order. What `report.state` returns. */
  reportRows: ReportRow[] = [];
  /** Which access has been granted. One-way, so neither ever goes back to false. */
  reportGrants = { source: false, detail: false };
  /** Where the open debug conversation is being written down, when there was somewhere to write it. */
  transcript: Transcript | undefined;
  /**
   * The last answer `graphDoc` built for each slug, held so a pane re-reading after its own write
   * does not pay for a parse of bytes it has already seen. Dropped by `forgetGraphDocs`, and
   * checked against a stat of every file it came from on every serve.
   */
  readonly heldGraphs = new Map<GraphSlug, HeldDoc<GraphDocRead>>();
  /** The same for `groupDoc`, by ref. */
  readonly heldGroups = new Map<string, HeldDoc<GroupDocRead>>();

  constructor(
    readonly dir: string,
    readonly mock: boolean,
    readonly deps: SessionDeps,
  ) {}

  /**
   * The work a caller must wait out before tearing this session down — a pipeline run or an
   * agent turn, named so a refusal can say which. Reported rather than enforced: nothing here
   * cancels, and a session that is busy is simply one nobody should replace yet.
   */

  busy(): string | undefined {
    return busyName(this.inFlight);
  }

  /**
   * Whether one named kind of work is in flight, whatever else is. A stop asks this rather than
   * reading {@link busy}, which names one kind and would hide the very work being stopped.
   */

  running(what: string): boolean {
    return this.inFlight.has(what);
  }

  /** What `busy()` says, plus how far along it is — the shape the window is pushed. */

  busyState(): { what?: string } & BusyProgress {
    const what = this.busy();
    return {
      ...(what ? { what } : {}),
      ...this.progress,
      ...(this.stopping() ? { stopping: true } : {}),
    };
  }

  /** Push {@link busyState} to the window. Called on both edges, and on every step between. */

  announceBusy(): void {
    this.deps.pushBusy(this.busyState());
  }

  async while<T>(what: string, run: () => Promise<T>): Promise<T> {
    this.inFlight.add(what);
    this.announceBusy();
    try {
      return await run();
    } finally {
      this.inFlight.delete(what);
      if (this.inFlight.size === 0) this.progress = { ran: 0, pending: 0 };
      this.announceBusy();
    }
  }

  /**
   * Hold the session for a whole approve-and-generate pass, rounds and gaps alike. One
   * `AbortController` covers all of it, which is what carries a stop asked for while the pass is
   * approving — when no run is in flight to receive it — into the round that follows.
   */

  duringPass<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cancel = new AbortController();
    this.cancel = cancel;
    return this.while(BUSY_PASS, () => body(cancel.signal)).finally(() => {
      if (this.cancel === cancel) this.cancel = undefined;
    });
  }

  /**
   * Ask the generative work in flight to stop. It stops at a request boundary, so this returns what
   * was asked rather than what happened — the run's own outcome says that.
   */

  stopPipeline(): boolean {
    if (!this.cancel) return false;
    this.cancel.abort();
    return true;
  }

  /** Whether a stop has been asked for and the work it stops is still in flight. */

  stopping(): boolean {
    return this.cancel?.signal.aborted === true;
  }

  /**
   * Stop the generative work in flight and cut off the tasks it is on, each of which goes back
   * to `pending`. Answers how many were in flight to cut, or `undefined` when nothing was running.
   */

  abortPipeline(): number | undefined {
    if (!this.stopPipeline()) return undefined;
    const cut = Object.keys(this.progress.activity ?? {}).length;
    this.abortTasks?.abort();
    return cut;
  }

  /**
   * Ask the agent turn in flight to end. Same contract as {@link stopPipeline}: the step in
   * progress finishes, so the transcript stays complete and the next turn reads a whole one.
   */

  stopAgent(): boolean {
    if (!this.running(BUSY_AGENT) || !this.agent) return false;
    this.agent.stop();
    return true;
  }

  /**
   * Ask the analyst turn in flight to end. Same contract as {@link stopAgent}, and the same reason
   * it is a separate handle: the convo editor's Stop button has no authority over a report.
   */

  stopReport(): boolean {
    if (!this.running(BUSY_REPORT) || !this.analyst) return false;
    this.analyst.stop();
    return true;
  }

  /**
   * All three permission hooks route to the renderer, and none of them may answer for the
   * author. An auto-allowed `confirmAction` would spend an image call the author never agreed
   * to, and an `ask` that resolves to nothing still reports `User answered:` to the model, which
   * then proceeds on whatever it guessed — in both cases the author's silence would be treated
   * as consent.
   */

  permission(): Permission {
    return {
      // A plan and its verdict are the decisive turns of a conversation, and neither reaches the
      // loop's event stream as a transcript line, so both are recorded here. The renderer runs
      // the same two reducers on its own copy.
      approvePlan: async (plan) => {
        const id = this.cardSeq++;
        this.record((convo) => proposed(convo, { id, plan }));
        const decision = await this.deps.requestPlan(plan);
        this.record((convo) => decided(convo, decision));
        return decision;
      },
      confirmAction: (tool, args) => this.deps.requestConfirm(tool, confirmDetail(tool, args)),
      // The author's answer never passes through `run` and the loop does not emit it, so only a
      // record made here keeps it — question included, since "the second one" is unreadable
      // without its list. A declined confirmation needs none of this: it is a `blocked` event.
      ask: async (form) => {
        const id = this.cardSeq++;
        const questions = [...form];
        this.record((convo) => queried(convo, { id, questions }));
        const answers = await this.deps.requestAnswer(questions);
        this.record((convo) => answeredQuestion(convo, answers));
        return answers;
      },
    };
  }

  /**
   * Reduce the conversation, and write whatever that added to the active thread. Returns nothing
   * and never throws: a transcript that cannot be appended to is worth a warning, not a failed
   * turn — the work the conversation was about has already happened.
   */

  record(reduce: (convo: Convo) => Convo): void {
    const before = this.convo.feed.length;
    this.convo = reduce(this.convo);
    const added = this.convo.feed.slice(before);
    const id = this.thread?.id;
    if (!id || added.length === 0) return;
    const paths = new ProjectPaths(this.dir);
    this.writes = this.writes
      .then(async () => {
        for (const item of added) await appendItem(paths, id, item);
      })
      .catch((err: unknown) => {
        console.warn(`[vnstudio] could not append to thread ${id}: ${String(err)}`);
      });
  }

  /**
   * Write one call's receipt to the active thread, and advance the step count. Separate from
   * `record` because a receipt is not a transcript line, and chained through the same promise so a
   * receipt lands between the lines it was earned between. Warns rather than throws, for the same
   * reason `record` does.
   */

  recordUsage(event: Extract<AgentEvent, { type: 'usage' }>): void {
    const step = this.step++;
    const id = this.thread?.id;
    if (!id) return;
    const paths = new ProjectPaths(this.dir);
    const usage: ThreadUsage = {
      step,
      input : event.input,
      output: event.output,
      ...(event.cacheRead === undefined ? {} : { cacheRead: event.cacheRead }),
      ...(event.cacheWrite === undefined ? {} : { cacheWrite: event.cacheWrite }),
      ...(event.cacheEstimated === undefined ? {} : { cacheEstimated: event.cacheEstimated }),
      ...(event.verdict === undefined ? {} : { verdict: event.verdict }),
      at: new Date().toISOString(),
    };
    this.writes = this.writes
      .then(() => appendUsage(paths, id, usage))
      .catch((err: unknown) => {
        console.warn(`[vnstudio] could not append usage to thread ${id}: ${String(err)}`);
      });
  }

  /**
   * Queue one native-log write behind the display log's, so the two files stay in the order the
   * conversation happened and `runAgent`'s single await covers both. A write that fails costs a
   * warning: a thread that cannot be continued later is not a reason to fail the turn in hand.
   */

  writeNative(id: string, line: NativeLine): void {
    const paths = new ProjectPaths(this.dir);
    this.writes = this.writes
      .then(() => appendNative(paths, id, line))
      .catch((err: unknown) => {
        console.warn(`[vnstudio] could not append to the history of thread ${id}: ${String(err)}`);
      });
  }

  /**
   * Write one message down verbatim, opening the log with its header line the first time. The
   * header is written here rather than by `beginThread` because it records what the conversation
   * is being had through, and the backend is not settled until a turn is about to run.
   */

  recordMessage(message: AgentMessage): void {
    const id = this.thread?.id;
    if (!id) return;
    if (!this.native.opened) {
      this.native.opened = true;
      this.writeNative(id, {
        v       : NATIVE_VERSION,
        type    : 'resume',
        thread  : id,
        at      : new Date().toISOString(),
        backend : this.native.kind,
        vendor  : chatVendorFor(this.model),
        sections: this.native.sections,
        ...(this.native.transport === undefined ? {} : { transport: this.native.transport }),
        ...(this.model === '' ? {} : { model: this.model }),
        ...(this.effort === undefined ? {} : { effort: this.effort }),
      });
    }
    const { role, content, toolUseId } = message;
    this.writeNative(id, {
      type: 'msg',
      n   : this.native.n++,
      at  : new Date().toISOString(),
      role,
      content,
      ...(toolUseId === undefined ? {} : { toolUseId }),
    });
  }
}
