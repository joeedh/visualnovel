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
import { relative, sep } from 'node:path';
import { openGit } from '@vn/git';
import {
  applySceneBranchEdit,
  assignLineIds,
  modelFromInputs,
  type SceneBranchEdit,
} from '@vn/model';
import { splitFrontMatter, type LoadedInputs } from '@vn/parse';
import {
  AssetStore,
  ProjectPaths,
  loadInputs,
  readShots,
  setCharacterApproval,
  writeApprovedPortrait,
  writeShots,
} from '@vn/store';
import { loadGraph, type TaskGraph } from '@vn/taskgraph';
import { writeFileAtomic } from '@vn/util';
import { costPreview, gateStatus, isApproved } from '@vn/pipeline';
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
import { buildPlayable, loadSceneShots } from '@vn/export';
import type { Playable, ProjectModel, Providers, Scene } from '@vn/types';
import type {
  ApproveResult,
  BranchEditResult,
  GateCandidate,
  PipelineRunResult,
  PipelineStatus,
  SceneCoverage,
  StoryGraph,
} from '../shared/ipc.js';
import { narrowTask } from './reviews.js';
import { storyGraphOf } from './storygraph.js';
import type { BranchOp } from '../shared/branchops.js';
import { setCoverage } from '../shared/coverage.js';

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

/**
 * One authored file holding scene prose, as the prose writers need it: `prefix + script` is the
 * file, and only `script` is ever patched. A chunk's `prefix` is its front-matter block, kept
 * byte-exact so a rewire never reformats YAML the author wrote.
 */
interface SceneSource {
  file: string;
  prefix: string;
  script: string;
  /** The scene ids this file holds — one for a chunk, all of them for a screenplay. */
  scenes: string[];
  /** Set for a chunk: the id front-matter gives it, which its body cannot override. */
  chunkId?: string;
}

/** A loaded project: config, paths, validated model, persisted store + task graph. */
interface LoadedProject {
  dir: string;
  config: ProjectConfig;
  paths: ProjectPaths;
  model: ProjectModel;
  store: AssetStore;
  graph: TaskGraph;
  /** The files this model's scenes were built from — the files a prose edit patches. */
  sources: SceneSource[];
}

/**
 * The prose files behind a model, in whichever form the project authored them. Derived from the
 * same `loadInputs` result the model was built from, so a writer cannot re-decide "which file is
 * the screenplay" and drift from the rule the reader used.
 */
function sourcesOf(inputs: LoadedInputs, model: ProjectModel): SceneSource[] {
  if (inputs.sceneDocs.length > 0) {
    return inputs.sceneDocs.map((chunk) => ({
      file: chunk.file,
      prefix: splitFrontMatter(chunk.text).prefix,
      script: chunk.doc.body,
      scenes: [chunk.id],
      chunkId: chunk.id,
    }));
  }
  if (!inputs.scriptPath) return [];
  return [
    {
      file: inputs.scriptPath,
      prefix: '',
      script: inputs.scriptText,
      scenes: [...model.scenes.keys()],
    },
  ];
}

/** The patcher options a source needs: a chunk forces its id, a screenplay reads its markers. */
function patchOptions(source: SceneSource): { sceneId?: string } {
  return source.chunkId === undefined ? {} : { sceneId: source.chunkId };
}

/** Workspace-relative and forward-slashed, which is what a `written` list reports. */
function relPath(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}

async function loadProject(dir: string): Promise<LoadedProject> {
  const config = await loadConfig(dir);
  const paths = new ProjectPaths(dir);
  const inputs = await loadInputs(paths);
  const model = modelFromInputs(inputs, { title: config.title, start: config.start });
  const store = await AssetStore.open(paths);
  const graph = await loadGraph(paths);
  return { dir, config, paths, model, store, graph, sources: sourcesOf(inputs, model) };
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

  /**
   * Whether an approval would land, without performing one: the character, the candidate, and
   * whether it is already approved. A read — `gate.approve` re-decides for itself.
   */
  async gateCandidacy(
    characterId: string,
    hash: string,
  ): Promise<{ character: boolean; candidate: boolean; approved: boolean; candidates: number }> {
    const project = await loadProject(this.dir);
    const character = project.model.characters.get(characterId);
    const candidates = project.store
      .manifest()
      .filter((a) => a.kind === 'portrait' && a.satisfies.characterId === characterId);
    return {
      character: Boolean(character),
      candidate: candidates.some((a) => a.hash === hash),
      approved: character ? isApproved(character) : false,
      candidates: candidates.length,
    };
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

  /** Scenes + branch edges for the STUDIO branch editor, derived from the validated model. */
  async storyGraph(): Promise<StoryGraph> {
    const project = await loadProject(this.dir);
    return storyGraphOf(project.model);
  }

  /**
   * The single write path for every `story.*` edit: decide the rewire against the freshly
   * loaded scenes, patch the branch markers in whichever file each scene lives in, write
   * atomically, and rebuild the model. `decide` is passed in rather than the edits themselves
   * so the decision and the patch see the same load — a scene list read a moment earlier could
   * already be stale.
   *
   * Rebuilding is not optional: reachability changes with the wiring, and a stale `reachable`
   * set would draw live scenes as dead.
   */
  async editBranches(decide: (scenes: Map<string, Scene>) => BranchOp): Promise<BranchEditResult> {
    const project = await loadProject(this.dir);
    const op = decide(project.model.scenes);
    if (!op.ok) return { ok: false, message: op.error, written: [] };
    if (project.sources.length === 0) {
      return { ok: false, message: 'This project has no scene files to edit.', written: [] };
    }

    const groups = new Map<SceneSource, SceneBranchEdit[]>();
    for (const edit of op.edits) {
      const source = project.sources.find((s) => s.scenes.includes(edit.sceneId));
      if (!source) {
        return { ok: false, message: `No file holds scene "${edit.sceneId}".`, written: [] };
      }
      groups.set(source, [...(groups.get(source) ?? []), edit]);
    }

    // Every patch is computed before any is written: a splice spanning three chunks that is
    // refused on the third must leave the first two exactly as they were.
    const pending: { source: SceneSource; text: string }[] = [];
    for (const [source, edits] of groups) {
      const patched = applySceneBranchEdit(source.script, edits, patchOptions(source));
      if (patched.diagnostics.length > 0) {
        return {
          ok: false,
          message: patched.diagnostics.map((d) => d.message).join(' '),
          written: [],
        };
      }
      if (patched.text !== source.script) pending.push({ source, text: patched.text });
    }

    if (pending.length === 0) {
      return {
        ok: true,
        message: `${op.message} (already wired that way — nothing written)`,
        written: [],
        graph: storyGraphOf(project.model),
      };
    }

    for (const { source, text } of pending) {
      await writeFileAtomic(source.file, source.prefix + text);
    }
    const reloaded = await loadProject(this.dir);
    return {
      ok: true,
      message: op.message,
      written: pending.map((p) => relPath(this.dir, p.source.file)),
      graph: storyGraphOf(reloaded.model),
    };
  }

  /**
   * The line-id patch every affected file would take, computed and not written. Shared by
   * `previewLineIds` and `writeLineIds` so a preview is the decision the write makes, not a
   * description of one — `assignLineIds` is the whole rule, including its safety net.
   */
  private async planLineIds(sceneId?: string): Promise<{
    ok: boolean;
    message: string;
    assigned: number;
    where: string;
    pending: { source: SceneSource; text: string }[];
  }> {
    const project = await loadProject(this.dir);
    const where = sceneId ? `scene "${sceneId}"` : 'the project';
    const fail = (message: string) => ({ ok: false, message, assigned: 0, where, pending: [] });

    if (project.sources.length === 0) return fail('This project has no scene files to edit.');
    const targets = sceneId
      ? project.sources.filter((s) => s.scenes.includes(sceneId))
      : project.sources;
    if (sceneId && targets.length === 0) return fail(`No file holds scene "${sceneId}".`);

    let assigned = 0;
    const pending: { source: SceneSource; text: string }[] = [];
    for (const source of targets) {
      // A chunk is already the one scene asked for; only a screenplay needs the filter.
      const patch = assignLineIds(
        source.script,
        source.chunkId === undefined ? sceneId : undefined,
      );
      if (patch.diagnostics.length > 0) {
        return fail(patch.diagnostics.map((d) => d.message).join(' '));
      }
      assigned += patch.assigned;
      if (patch.text !== source.script) pending.push({ source, text: patch.text });
    }
    return { ok: true, message: '', assigned, where, pending };
  }

  /** What `writeLineIds` would do, without doing it. */
  async previewLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; assigned: number }> {
    const plan = await this.planLineIds(sceneId);
    if (!plan.ok) return { ok: false, message: plan.message, assigned: 0 };
    return {
      ok: true,
      message: plan.assigned
        ? `${plan.assigned} line id(s) would be written into ${plan.where}.`
        : `Every line in ${plan.where} already carries its id.`,
      assigned: plan.assigned,
    };
  }

  /**
   * Persist the ids reading already allocated as `[[line:]]` marks. Nothing about the model
   * changes — the ids are the same ones `splitScenes` handed out — so this writes the prose
   * files and reports; the point is that a *later* insertion can no longer shift them.
   */
  async writeLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const plan = await this.planLineIds(sceneId);
    if (!plan.ok) return { ok: false, message: plan.message, written: [] };
    if (plan.pending.length === 0) {
      return {
        ok: true,
        message: `Every line in ${plan.where} already carries its id.`,
        written: [],
      };
    }

    for (const { source, text } of plan.pending) {
      await writeFileAtomic(source.file, source.prefix + text);
    }
    return {
      ok: true,
      message: `Wrote ${plan.assigned} line id(s) into ${plan.where}.`,
      written: plan.pending.map((p) => relPath(this.dir, p.source.file)),
    };
  }

  /**
   * One scene's script and shots for the coverage timeline. Shots come off disk: a model built
   * from inputs carries none, and the persisted decomposition is the one the run illustrated.
   */
  async sceneCoverage(sceneId: string): Promise<SceneCoverage> {
    const project = await loadProject(this.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) throw new Error(`No scene "${sceneId}".`);

    const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    const exts = new Map(project.store.manifest().map((a) => [a.hash, a.ext]));
    return {
      sceneId,
      location: scene.location,
      lines: scene.lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        ...(l.speaker ? { speaker: l.speaker } : {}),
        text: l.text,
      })),
      shots: (loaded?.shots ?? []).map((s) => ({
        id: s.id,
        framing: s.framing,
        subjects: s.subjects.map((sub) => sub.characterId),
        coversLines: s.coversLines,
        status: s.status,
        ...(s.image ? { image: { hash: s.image, ext: exts.get(s.image) ?? 'png' } } : {}),
      })),
      decomposed: loaded !== null,
    };
  }

  /**
   * Rewrite one shot's coverage. The rule is `shared/coverage.ts`, so the timeline's mid-drag
   * preview and this write cannot disagree; only `coversLines` is touched, and `buildShotPrompt`
   * ignores it, so no task rehashes and no generated art is invalidated.
   */
  async setCoverage(
    sceneId: string,
    shotId: string,
    lines: readonly string[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const project = await loadProject(this.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) return { ok: false, message: `No scene "${sceneId}".`, written: [] };

    const lineOrder = scene.lines.map((l) => l.id);
    const loaded = await readShots(project.paths, sceneId, new Set(lineOrder));
    if (!loaded) {
      return {
        ok: false,
        message: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
        written: [],
      };
    }

    const op = setCoverage(loaded.shots, { shot: shotId, lines, lineOrder });
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    const next = new Map(op.changed.map((s) => [s.id, s.coversLines]));
    const shots = loaded.shots.map((s) => ({ ...s, coversLines: next.get(s.id) ?? s.coversLines }));
    await writeShots(project.paths, sceneId, shots);

    const gaps = op.uncovered.length ? ` ${op.uncovered.length} line(s) now uncovered.` : '';
    return {
      ok: true,
      message: op.message + gaps,
      written: [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.sceneCoverage(sceneId),
    };
  }

  /** Build the playable live from the current model + asset store (no file needed). */
  async playable(): Promise<Playable> {
    const project = await loadProject(this.dir);
    const shots = await loadSceneShots(project.paths, project.model);
    return buildPlayable(project.model, project.store, shots);
  }

  /** Write the playable to `vngen/build/story.play.json` — the `vngen export` equivalent. */
  async exportPlayable(): Promise<{ path: string; scenes: number }> {
    const project = await loadProject(this.dir);
    const shots = await loadSceneShots(project.paths, project.model);
    const playable = buildPlayable(project.model, project.store, shots);
    await writeFileAtomic(project.paths.storyPlay, JSON.stringify(playable, null, 2) + '\n');
    return { path: project.paths.storyPlay, scenes: Object.keys(playable.scenes).length };
  }

  async status(): Promise<PipelineStatus> {
    const project = await loadProject(this.dir);
    const gate = gateStatus(project.model);
    const exts = new Map(project.store.manifest().map((a) => [a.hash, a.ext]));
    return {
      tasks: [...project.graph.all()].map((t) => narrowTask(t, (hash) => exts.get(hash))),
      gatePending: gate.pending,
      blockedOnGate: !gate.cleared,
    };
  }

  /**
   * What a run would find, without planning one. Planning is not free and not read-only —
   * `planTasks` mutates the graph and may call the decomposer — so this reports the *already
   * planned* pending work and the gate, and separately whether the keys a real run needs
   * resolve. Incremental planning means "nothing pending" is not "nothing to do", so the count
   * is a report, never a refusal.
   */
  async runPreconditions(mock: boolean): Promise<{
    pending: number;
    blockedOnGate: boolean;
    gatePending: string[];
    /** Why keys did not resolve — naming the source, never a value. Null when they did. */
    keyError: string | null;
  }> {
    const project = await loadProject(this.dir);
    const gate = gateStatus(project.model);
    let keyError: string | null = null;
    if (!mock) {
      try {
        await resolveKeys(project.config, {
          secretsDirs: await secretDirsFor(project.dir),
          require: ['gemini'],
        });
      } catch (err) {
        keyError = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      pending: costPreview(project.graph, project.config).pendingTasks,
      blockedOnGate: !gate.cleared,
      gatePending: gate.pending,
      keyError,
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
