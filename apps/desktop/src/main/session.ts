/**
 * One workspace's worth of backend state, owned by the Electron main process. This is the
 * desktop app's join point: it embeds BOTH the authoring agent (`@vn/authoring`) and the
 * generative scheduler (`@vn/scheduler`) in-process and exposes them as plain async methods
 * the IPC layer can call. The glue mirrors `apps/authoring/src/agent.ts` (agent assembly)
 * and `apps/cli/src/project.ts` (project + provider construction); it is intentionally not
 * imported from those apps, which aren't libraries.
 */
import {
  loadConfig,
  resolveKeys,
  secretDirsFor,
  type ProjectConfig,
  type ResolvedKeys,
} from '@vn/config';
import { openGit } from '@vn/git';
import { parseFountain } from '@vn/parse';
import { buildModel } from '@vn/model';
import {
  AssetStore,
  ProjectPaths,
  loadInputs,
  setCharacterApproval,
  writeApprovedPortrait,
} from '@vn/store';
import { loadGraph, type TaskGraph } from '@vn/taskgraph';
import { gateStatus } from '@vn/pipeline';
import {
  createAnthropicChat,
  createGeminiChat,
  createMockProviders,
  createProviders,
  type ChatBackend,
} from '@vn/providers';
import {
  Agent,
  StructuredAgentBackend,
  Workspace,
  composeSystem,
  loadContext,
  type AgentBackend,
  type AgentEvent,
  type AgentMode,
  type Permission,
  type Plan,
  type PlanDecision,
  type RunResult,
  type ToolContext,
  type WorkspaceIndex,
} from '@vn/authoring';
import { runPipeline } from '@vn/scheduler';
import { buildPlayable } from '@vn/export';
import type { Playable, ProjectModel, Providers } from '@vn/types';
import type {
  ApproveResult,
  GateCandidate,
  PipelineRunResult,
  PipelineStatus,
} from '../shared/ipc.js';

/** A backend that does no LLM work — lets the app run offline (mirrors the REPL's --mock). */
class MockAgentBackend implements AgentBackend {
  next(): Promise<{ final: string }> {
    return Promise.resolve({
      final:
        '[mock] No model is configured (running offline). I can read the workspace, but I ' +
        'cannot reason about edits without a model. Provide a key and switch off mock to use one.',
    });
  }
}

/** Pick the vendor chat backend for a text model id (mirrors @vn/providers' private picker). */
function chatBackendFor(modelId: string, keys: ResolvedKeys): ChatBackend {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude') || id.startsWith('anthropic')) {
    return createAnthropicChat(keys.anthropic, modelId);
  }
  return createGeminiChat(keys.gemini, modelId);
}

/** Hooks the session uses to reach the renderer (events out, plan approval round-trip). */
export interface SessionDeps {
  emitEvent(event: AgentEvent): void;
  requestPlan(plan: Plan): Promise<PlanDecision>;
}

/** A loaded project: config, paths, validated model, persisted store + task graph. */
interface LoadedProject {
  dir: string;
  config: ProjectConfig;
  paths: ProjectPaths;
  model: ProjectModel;
  store: AssetStore;
  graph: TaskGraph;
}

async function loadProject(dir: string): Promise<LoadedProject> {
  const config = await loadConfig(dir);
  const paths = new ProjectPaths(dir);
  const inputs = await loadInputs(paths);
  const script = parseFountain(inputs.scriptText);
  const model = buildModel({
    title: config.title,
    characterDocs: inputs.characterDocs,
    locationDocs: inputs.locationDocs,
    script,
  });
  const store = await AssetStore.open(paths);
  const graph = await loadGraph(paths);
  return { dir, config, paths, model, store, graph };
}

async function buildProviders(project: LoadedProject, mock: boolean): Promise<Providers> {
  const loadRef = async (ref: { hash: string; ext: string }) => ({
    bytes: await project.store.read(ref),
    ext: ref.ext,
  });
  if (mock) return createMockProviders({ refLoader: loadRef });
  const keys = await resolveKeys(project.config, {
    secretsDirs: await secretDirsFor(project.dir),
    require: ['gemini'],
  });
  return createProviders({ config: project.config, keys, loadRef });
}

/** Backend state for a single workspace, addressed by the IPC handlers in `index.ts`. */
export class WorkspaceSession {
  private agent: Agent | undefined;
  /** The text model the agent is bound to (what a future `/model` would report). */
  model = '';

  constructor(
    readonly dir: string,
    readonly mock: boolean,
    private readonly deps: SessionDeps,
  ) {}

  /** Plan approval routes to the renderer; tool confirmation auto-allows for now (scaffold). */
  private permission(): Permission {
    return {
      approvePlan: (plan) => this.deps.requestPlan(plan),
      // TODO(desktop): route confirmAction / ask through the renderer too once the
      // corresponding UI (skill-run confirm, free-form prompts) is built.
      confirmAction: () => Promise.resolve(true),
      ask: () => Promise.resolve(''),
    };
  }

  private async buildBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    if (this.mock) return new MockAgentBackend();
    const modelId = model ?? config.models.text;
    const vendor = modelId.toLowerCase().startsWith('claude') ? 'anthropic' : 'gemini';
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(this.dir),
      require: [vendor],
    });
    return new StructuredAgentBackend(chatBackendFor(modelId, keys));
  }

  private async ensureAgent(): Promise<Agent> {
    if (this.agent) return this.agent;
    const ctx: ToolContext = { workspace: new Workspace(this.dir), git: openGit(this.dir) };
    const context = await loadContext(this.dir);
    const config = await loadConfig(this.dir);
    this.model = config.models.text;
    this.agent = new Agent({
      backend: await this.buildBackend(config),
      ctx,
      permission: this.permission(),
      system: composeSystem(context),
      onEvent: (event) => this.deps.emitEvent(event),
    });
    return this.agent;
  }

  // ---- IPC-facing methods ----

  index(): Promise<WorkspaceIndex> {
    return new Workspace(this.dir).index();
  }

  async runAgent(input: string): Promise<RunResult> {
    return (await this.ensureAgent()).run(input);
  }

  async setMode(mode: AgentMode): Promise<AgentMode> {
    const agent = await this.ensureAgent();
    agent.setMode(mode);
    return agent.currentMode;
  }

  /** Hot-swap the text model and rebuild the backend, preserving conversation state. */
  async setModel(modelId: string): Promise<string> {
    this.model = modelId;
    if (this.mock) return modelId;
    const agent = await this.ensureAgent();
    agent.setBackend(await this.buildBackend(await loadConfig(this.dir), modelId));
    return modelId;
  }

  async clearAgent(): Promise<void> {
    (await this.ensureAgent()).clear();
  }

  /** Portrait candidates for a character at the approval gate (from the manifest). */
  async gateCandidates(characterId: string): Promise<GateCandidate[]> {
    const project = await loadProject(this.dir);
    return project.store
      .manifest()
      .filter((a) => a.kind === 'portrait' && a.satisfies.characterId === characterId)
      .map((a) => ({ hash: a.hash, accepted: a.accepted }));
  }

  /** Flip a character to approved with `hash`: copy the visible portrait, accept the asset. */
  async approveCharacter(characterId: string, hash: string): Promise<ApproveResult> {
    const project = await loadProject(this.dir);
    if (!project.store.has(hash)) return { ok: false, message: `No asset "${hash}" in the store.` };
    const flipped = await setCharacterApproval(project.paths, characterId, hash);
    if (!flipped) return { ok: false, message: `No character file for "${characterId}".` };
    const bytes = await project.store.read({ hash, ext: 'png' });
    await writeApprovedPortrait(project.paths, characterId, bytes);
    await project.store.accept(hash);
    return { ok: true, message: `Approved ${characterId} → ${hash}.` };
  }

  /** Build the playable live from the current model + asset store (no file needed). */
  async playable(): Promise<Playable> {
    const project = await loadProject(this.dir);
    return buildPlayable(project.model, project.store);
  }

  async status(): Promise<PipelineStatus> {
    const project = await loadProject(this.dir);
    const gate = gateStatus(project.model);
    return {
      tasks: [...project.graph.all()],
      gatePending: gate.pending,
      blockedOnGate: !gate.cleared,
    };
  }

  async runPipeline(mock: boolean): Promise<PipelineRunResult> {
    const project = await loadProject(this.dir);
    const providers = await buildProviders(project, mock);
    const summary = await runPipeline({
      model: project.model,
      graph: project.graph,
      store: project.store,
      providers,
      config: project.config,
      paths: project.paths,
      dryRun: mock,
      now: () => new Date().toISOString(),
    });
    return {
      ran: summary.ran.length,
      blockedOnGate: summary.blockedOnGate,
      gatePending: summary.gate.pending,
      preview: {
        pendingTasks: summary.preview.pendingTasks,
        imageCalls: summary.preview.imageCalls,
        reviewCalls: summary.preview.reviewCalls,
      },
    };
  }
}
