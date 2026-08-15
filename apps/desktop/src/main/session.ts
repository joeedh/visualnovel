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
  setStartScene,
  type ProjectConfig,
  type ResolvedKeys,
} from '@vn/config';
import { readdir, rename } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { openGit } from '@vn/git';
import {
  applyCharacterEdit,
  applyLocationEdit,
  assignLineIds,
  characterFromDoc,
  docToMarkdown,
  locationFromDoc,
  modelFromInputs,
  newCharacterDoc,
  newLocationDoc,
  sceneChunksFromScript,
  scriptFromScenes,
  slug,
  type CharacterEdit,
  type LocationEdit,
  type SceneChunk,
} from '@vn/model';
import { parseFountain, type FrontMatterDoc, type LoadedInputs } from '@vn/parse';
import {
  AssetStore,
  ProjectPaths,
  checkDocWrite,
  conventionalKind,
  entityDoc,
  entityFile,
  findScreenplay,
  isBaseKind,
  loadInputs,
  readDocFile,
  readSceneChunks,
  readShots,
  setCharacterApproval,
  taggedKind,
  writeApprovedPortrait,
  writeDocFile,
  writeSceneChunk,
  writeShots,
  type DocFile,
  type DocResult,
  type DocWritePlan,
} from '@vn/store';
import { loadGraph, logTask, type TaskGraph } from '@vn/taskgraph';
import { exists, readText, writeFileAtomic } from '@vn/util';
import { baseRefusal, costPreview, driftOf, gateStatus, isApproved } from '@vn/pipeline';
import {
  formatSubject,
  generateConcept,
  matchSubject,
  parseSubject,
  promoteConcept,
  promotionOf,
  redrawConcept,
  redrawOf,
  subjectEntity,
  type ConceptRequest,
} from '@vn/artgen';
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
  workspaceArtGen,
  type AgentBackend,
  type AgentEvent,
  type AgentMode,
  type GeneratedContextState,
  type GeneratedCounts,
  type Permission,
  type Plan,
  type PlanDecision,
  type RunResult,
  type ToolContext,
  type WorkspaceIndex,
} from '@vn/authoring';
import type { Excerpt } from '@vn/bible';
import { runPipeline } from '@vn/scheduler';
import { buildPlayable, loadSceneShots } from '@vn/export';
import {
  moveShot,
  setSceneOutfit,
  setShotOutfit,
  wardrobesOf,
  type LineOp,
  type SceneOutfitOp,
  type ScriptState,
  type ShotOutfitOp,
} from '@vn/scriptedit';
import {
  applyMarkerPlan,
  applyScenePlan,
  planMarkerEdit,
  planSceneEdit,
  scenePlanMessage,
  scriptStateOf,
  sourcesOf,
  type SceneEditInput,
  type ScenePlan,
  type SceneSource,
} from '@vn/scriptedit/write';
import type { AnyTask, Effort, Playable, ProjectModel, Providers, Scene, Shot } from '@vn/types';
import { bindsTo } from '@vn/types';
import type {
  ApproveResult,
  AssetInfo,
  BranchEditResult,
  DocNode,
  DocSaveResult,
  DocTree,
  GateCandidate,
  PipelineRunResult,
  PipelineStatus,
  SceneCoverage,
  SceneEditResult,
  StoryGraph,
} from '../shared/ipc.js';
import { narrowTask } from './reviews.js';
import { parseArtTarget, rungAt, rungsFor, type ArtTarget } from './artnotes.js';
import { labelAssets, labelContext } from './assetlabel.js';
import { derivePrompt } from './assetprompt.js';
import { buildDocTree, fileTree } from './doctree.js';
import { storyGraphOf } from './storygraph.js';
import { confirmDetail } from './toolconfirm.js';
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
function chatBackendFor(modelId: string, keys: ResolvedKeys, effort?: Effort): ChatBackend {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude') || id.startsWith('anthropic')) {
    return createAnthropicChat(keys.anthropic, modelId, { effort });
  }
  return createGeminiChat(keys.gemini, modelId);
}

/** Hooks the session uses to reach the renderer: events out, and the three permission doors. */
export interface SessionDeps {
  emitEvent(event: AgentEvent): void;
  requestPlan(plan: Plan): Promise<PlanDecision>;
  /** The author's answer to a clarifying question. Empty is an answer — silence, said out loud. */
  requestAnswer(question: string): Promise<string>;
  /** Yes or no to an always-confirm tool. `detail` is the English sentence the card reads out. */
  requestConfirm(tool: string, detail: string): Promise<boolean>;
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
  /** Every discovered sheet and scene chunk, each carrying the file it was found in; entities are
   * tagged, not filed, so this is the only answer to where one lives. */
  inputs: LoadedInputs;
}

/** The three things `@vn/scriptedit` decides and writes against, off one load. */
const editInputOf = (project: LoadedProject): SceneEditInput => ({
  paths: project.paths,
  sources: project.sources,
  ...(project.config.start === undefined ? {} : { entry: project.config.start }),
});

/** Workspace-relative and forward-slashed, which is what a `written` list reports. */
function relPath(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}

/**
 * Every scene's persisted storyboard, by scene id. A storyboard that will not parse is one
 * scene's problem: with `reportBroken` it becomes a `null` the tree draws a badge for, and
 * without it the scene is simply absent, which is what every other reader wants.
 */
async function readAllShots(
  project: LoadedProject,
  opts: { reportBroken?: boolean } = {},
): Promise<Map<string, Shot[] | null>> {
  const shots = new Map<string, Shot[] | null>();
  for (const scene of project.model.scenes.values()) {
    const ids = new Set(scene.lines.map((l) => l.id));
    try {
      const loaded = await readShots(project.paths, scene.id, ids);
      if (loaded) shots.set(scene.id, loaded.shots);
    } catch {
      if (opts.reportBroken) shots.set(scene.id, null);
    }
  }
  return shots;
}

/** A shot with its art notes set, or removed when the text is blank. `Shot` is flat, so this is it. */
function withArtNotes(shot: Shot, notes: string): Shot {
  const { artNotes: _drop, ...rest } = shot;
  return notes.trim() ? { ...rest, artNotes: notes.trim() } : rest;
}

/**
 * The character edit one rung's worth of notes amounts to. An outfit rung has to resend the whole
 * wardrobe — `applyCharacterEdit` replaces the map — so it is rebuilt from what the model already
 * normalized, with the one entry changed.
 */
function characterNotesEdit(
  project: LoadedProject,
  target: Extract<ArtTarget, { kind: 'character' }>,
  notes: string,
): CharacterEdit {
  if (!target.outfit) return { artNotes: notes.trim() };
  const character = project.model.characters.get(target.id)!;
  return {
    outfits: Object.fromEntries(
      character.outfits.map((o) => {
        const art = o.id === target.outfit ? notes.trim() : (o.artNotes ?? '');
        // Empty keys are left out rather than written blank, matching `wardrobeData`.
        return [
          o.id,
          art
            ? { ...(o.description ? { description: o.description } : {}), art_notes: art }
            : o.description,
        ];
      }),
    ),
  };
}

/** The same for a location; a variant rung resends the whole list for the same reason. */
function locationNotesEdit(
  project: LoadedProject,
  target: Extract<ArtTarget, { kind: 'location' }>,
  notes: string,
): LocationEdit {
  if (!target.variant) return { artNotes: notes.trim() };
  const location = project.model.locations.get(target.id)!;
  return {
    variants: location.variants.map((v) => {
      const art = v.id === target.variant ? notes.trim() : (v.artNotes ?? '');
      return v.description || art
        ? {
            id: v.id,
            ...(v.description ? { description: v.description } : {}),
            ...(art ? { art_notes: art } : {}),
          }
        : v.id;
    }),
  };
}

/** Directories no file tree of a project should ever show, and the walk's cap. */
const TREE_SKIP = new Set(['.git', 'node_modules']);

/** Who owns `scenes/**` from this side of the app — the sentence a refused whole-file save gets. */
const SCENE_WRITER = 'story.*';

/** The three things `doc.create` scaffolds. A note is a title and nothing else. */
export type NewDocKind = 'character' | 'location' | 'note';

/**
 * What the model will make of a document that has already been saved — a sentence, or nothing.
 * Dispatch is by the tag the incoming text carries, falling back to the conventional home, which
 * is how discovery decides; a file that claims to be neither is a note and is not checked.
 */
function entityDiagnostic(path: string, doc: FrontMatterDoc): string | undefined {
  const kind = taggedKind(doc.data) ?? conventionalKind(path);
  if (kind === undefined) return undefined;
  const res = kind === 'character' ? characterFromDoc(doc) : locationFromDoc(doc);
  return res.ok ? undefined : res.diagnostic.message;
}
const TREE_MAX_FILES = 5000;

/**
 * Every file under `dir` as workspace-relative `/` paths. Bounded rather than exhaustive: a
 * project holding a copied asset library should slow the sidebar down, not the main process.
 */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (abs: string, prefix: string): Promise<void> => {
    if (out.length >= TREE_MAX_FILES) return;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= TREE_MAX_FILES) return;
      if (TREE_SKIP.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(abs, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await visit(dir, '');
  return out;
}

async function loadProject(dir: string): Promise<LoadedProject> {
  const config = await loadConfig(dir);
  const paths = new ProjectPaths(dir);
  const inputs = await loadInputs(paths);
  const model = modelFromInputs(inputs, { title: config.title, start: config.start });
  const store = await AssetStore.open(paths);
  const graph = await loadGraph(paths);
  return {
    dir,
    config,
    paths,
    model,
    store,
    graph,
    sources: sourcesOf(inputs),
    inputs,
  };
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
  private bibleWorkspace: Workspace | undefined;
  /** The text model the agent is bound to (what a future `/model` would report). */
  model = '';
  /** The reasoning effort the backend is built with; `undefined` is the vendor default. */
  effort: Effort | undefined;

  /** What long-running work is in flight, by name; empty when the session is idle. */
  private readonly inFlight = new Set<string>();

  constructor(
    readonly dir: string,
    readonly mock: boolean,
    private readonly deps: SessionDeps,
  ) {}

  /**
   * The work a caller must wait out before tearing this session down — a pipeline run or an
   * agent turn, named so a refusal can say which. Reported rather than enforced: nothing here
   * cancels, and a session that is busy is simply one nobody should replace yet.
   */
  busy(): string | undefined {
    return [...this.inFlight][0];
  }

  private async while<T>(what: string, run: () => Promise<T>): Promise<T> {
    this.inFlight.add(what);
    try {
      return await run();
    } finally {
      this.inFlight.delete(what);
    }
  }

  /**
   * All three doors route to the renderer. None of them may answer for the author: an
   * auto-allowed `confirmAction` spends an image call the author never agreed to, and an `ask`
   * that resolves to nothing still reports `User answered:` to the model, which then proceeds on
   * whatever it guessed — silence that reads as consent, twice over.
   */
  private permission(): Permission {
    return {
      approvePlan: (plan) => this.deps.requestPlan(plan),
      confirmAction: (tool, args) => this.deps.requestConfirm(tool, confirmDetail(tool, args)),
      ask: (question) => this.deps.requestAnswer(question),
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
    return new StructuredAgentBackend(chatBackendFor(modelId, keys, this.effort));
  }

  private async ensureAgent(): Promise<Agent> {
    if (this.agent) return this.agent;
    const workspace = new Workspace(this.dir);
    const ctx: ToolContext = {
      workspace,
      git: openGit(this.dir),
      // The agent's `generate_image` and the palette's `art.generate` draw the same picture; the
      // session's own `mock` is the only policy about whether it is real art.
      art: workspaceArtGen(workspace, { mock: this.mock }),
    };
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

  /** Where the agent's generated project map lives, and whether it is ours to replace. */
  generatedContext(): Promise<GeneratedContextState> {
    return new Workspace(this.dir).generatedContext();
  }

  /** Rebuild that map. Throws over a file at that path the generator did not write. */
  writeGeneratedContext(): Promise<{ file: string; counts: GeneratedCounts }> {
    return new Workspace(this.dir).writeGeneratedContext();
  }

  /**
   * Ranked passages from the story bible. Held on one `Workspace` so the index survives between
   * searches — every other method here rebuilds, because every other method reads authored input
   * that a command may just have written.
   */
  async searchBible(query: string, limit?: number): Promise<Excerpt[]> {
    this.bibleWorkspace ??= new Workspace(this.dir);
    const bible = await this.bibleWorkspace.bible();
    return bible.query(query, limit === undefined ? {} : { limit });
  }

  async runAgent(input: string): Promise<RunResult> {
    return this.while('an agent turn', async () => (await this.ensureAgent()).run(input));
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

  /**
   * Hot-swap the reasoning effort the same way. A model that does not honour one keeps the
   * setting anyway — `supportsEffort` is what a surface greys out on, and the backend simply
   * omits the knob — so switching back to a model that does needs no second gesture.
   */
  async setEffort(effort: Effort | undefined): Promise<Effort | undefined> {
    this.effort = effort;
    if (this.mock) return effort;
    const agent = await this.ensureAgent();
    agent.setBackend(await this.buildBackend(await loadConfig(this.dir), this.model || undefined));
    return effort;
  }

  async clearAgent(): Promise<void> {
    (await this.ensureAgent()).clear();
  }

  /** Portrait candidates for a character at the approval gate (from the manifest). */
  async gateCandidates(characterId: string): Promise<GateCandidate[]> {
    const project = await loadProject(this.dir);
    return project.store
      .manifest()
      .filter((a) => a.kind === 'portrait' && bindsTo(a, { characterId }))
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
      .filter((a) => a.kind === 'portrait' && bindsTo(a, { characterId }));
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
    const file = entityFile(project.inputs.characterDocs, characterId);
    if (!file || !(await setCharacterApproval(file, hash))) {
      return { ok: false, message: `No character file for "${characterId}".` };
    }
    const bytes = await project.store.read({ hash, ext: 'png' });
    await writeApprovedPortrait(project.paths, characterId, bytes);
    await project.store.accept(hash);
    return { ok: true, message: `Approved ${characterId} → ${hash}.` };
  }

  /**
   * Everything the asset editor draws for one asset: what the bytes are, the prompt they were
   * made from, the prompt the builders would write now, and the art-notes rungs that reach it.
   * `null` when the manifest has never heard of the hash.
   */
  async assetInfo(hash: string): Promise<AssetInfo | null> {
    const project = await loadProject(this.dir);
    const manifest = project.store.manifest();
    const asset = manifest.find((a) => a.hash === hash);
    if (!asset) return null;

    const shots = await readAllShots(project);
    const task = project.graph.get(asset.sourceTask);
    const ctx = { model: project.model, config: project.config, shots, ...(task ? { task } : {}) };
    const derived = derivePrompt(asset, ctx);
    return {
      hash: asset.hash,
      ext: asset.ext,
      kind: asset.kind,
      label: labelAssets(manifest, labelContext(project.model, project.graph)).get(hash) ?? hash,
      base: isBaseKind(asset.kind),
      accepted: asset.accepted,
      sourceTask: asset.sourceTask,
      ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }),
      ...(asset.title === undefined ? {} : { title: asset.title }),
      ...(derived === undefined ? {} : { derived }),
      // An unknown derivation is not evidence of drift — it means the project no longer describes
      // this asset, which the editor says a different way.
      stale: derived !== undefined && asset.prompt !== undefined && derived !== asset.prompt,
      rungs: rungsFor(asset, { model: project.model, shots }),
    };
  }

  /**
   * Whether accepting this asset is a question worth answering. Two kinds are refused by name:
   * a portrait, because approving one also writes `character.md` and `approved.png` and that is
   * `gate.approve`; and a concept, because nothing downstream consumes one, so `accepted` would
   * mean nothing. Already accepted is not a refusal — re-accepting is how an author changes
   * their mind.
   */
  async previewAccept(hash: string): Promise<{ ok: boolean; message: string }> {
    const info = await this.assetInfo(hash);
    if (!info) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    if (info.kind === 'portrait') {
      // The character rung is the widest one a portrait has, so its target names the character
      // without asking for the binding a second time.
      const who = info.rungs[0]?.target.split(':')[1];
      const call = who ? `(characterId='${who}' hash='${hash}')` : '';
      return {
        ok: false,
        message: `${info.label} is a portrait; use gate.approve${call}, which also writes character.md and approved.png.`,
      };
    }
    if (info.kind === 'concept') {
      return {
        ok: false,
        message: `${info.label} is a concept; nothing downstream consumes one. Use art.promote(hash='${hash}' variant=…) to make it a location plate.`,
      };
    }
    return {
      ok: true,
      message: info.accepted
        ? `${info.label} is already accepted; would re-accept it.`
        : `Would accept ${info.label}.`,
    };
  }

  /**
   * Mark an asset as the accepted one for what it satisfies. Generic across both roots, and it
   * asks {@link previewAccept} first rather than trusting that a check ran — a precondition is a
   * sentence a surface may show, never a gate the command may lean on.
   */
  async acceptAsset(hash: string): Promise<{ ok: boolean; message: string }> {
    const allowed = await this.previewAccept(hash);
    if (!allowed.ok) return allowed;
    const project = await loadProject(this.dir);
    if (!project.store.has(hash)) return { ok: false, message: `No asset "${hash}" in the store.` };
    await project.store.accept(hash);
    return { ok: true, message: `Accepted ${hash.slice(0, 8)}.` };
  }

  /**
   * Whether a regeneration would land, and the task it would requeue. Shared by the check and the
   * write so the refusal a surface shows is the refusal the command gives.
   *
   * A `stale` asset is refused on purpose: its task is an orphan (the prompt moved on, so the
   * planner now wants a different hash), and requeueing it would spend a real image call
   * reproducing the picture the author just edited away from. `tasks.jsonl` is never pruned, so
   * without this the log's dead nodes stay re-runnable forever.
   */
  private async regeneration(
    hash: string,
  ): Promise<{ ok: false; reason: string } | { ok: true; task: AnyTask; note: string }> {
    const info = await this.assetInfo(hash);
    if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    const project = await loadProject(this.dir);
    if (project.store.base.state === 'unavailable') {
      return {
        ok: false,
        reason: baseRefusal(project.store.base) ?? 'Base assets are unavailable.',
      };
    }
    // A concept's `sourceTask` is a hash of the request and deliberately not a node, so the
    // generic "no task" refusal below would be true and useless. Redrawing one is its own act.
    if (info.kind === 'concept') {
      return {
        ok: false,
        reason: `${info.label} is a concept: the planner never made it, so there is no task to re-run. Draw it again with art.redraw(hash='${hash}'), which takes an edited prompt.`,
      };
    }
    const task = info.sourceTask ? project.graph.get(info.sourceTask) : undefined;
    if (!task) {
      return {
        ok: false,
        reason: `${info.label} records no task in the graph, so there is nothing to re-run.`,
      };
    }
    if (info.stale) {
      return {
        ok: false,
        reason: `${info.label} was rendered from a prompt the project has since changed, so its task is an orphan. Run the pipeline — a fresh task is already planned for it.`,
      };
    }
    // With a fixed seed the same prompt and the same references give back the same bytes, so
    // say so rather than letting an author spend a call finding out.
    const seeded = project.config.image_params.seed !== undefined;
    return {
      ok: true,
      task,
      note: seeded
        ? `Would re-run ${task.kind} for ${info.label} — image_params.seed is fixed, so expect the same picture. Art notes are how the picture changes.`
        : `Would re-run ${task.kind} for ${info.label}.`,
    };
  }

  /** What `asset.regenerate` would do, without doing it. */
  async previewRegenerate(hash: string): Promise<{ ok: boolean; message: string }> {
    const decided = await this.regeneration(hash);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Put an asset's task back to `pending` so the next run re-renders it. Appending a `pending`
   * snapshot to `tasks.jsonl` *is* the requeue — `loadGraph` replays last-writer-wins, which is
   * how `requeueFailed` already works — so this needs no new scheduler machinery.
   */
  async regenerateAsset(
    hash: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const decided = await this.regeneration(hash);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const project = await loadProject(this.dir);
    await logTask(project.paths, {
      ...decided.task,
      status: 'pending',
      output: undefined,
      error: undefined,
    });
    return {
      ok: true,
      message: `Queued ${decided.task.kind} ${decided.task.hash.slice(0, 8)} for re-run.`,
      written: [relPath(this.dir, project.paths.tasksLog)],
    };
  }

  /** What `art.setNotes` would do, without writing it. */
  async previewArtNotes(target: string, notes: string): Promise<{ ok: boolean; message: string }> {
    const project = await loadProject(this.dir);
    const decided = await this.artNotesPlan(project, target, notes);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Write one art-notes rung. An entity rung goes through `@vn/model`'s `apply*Edit` into the
   * sheet the model was built from — the same path `vnauthor`'s `edit_character` takes, so one
   * authorial act has one answer — and a shot rung goes into `work/shots/<sceneId>.json`.
   */
  async setArtNotes(
    target: string,
    notes: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const project = await loadProject(this.dir);
    const decided = await this.artNotesPlan(project, target, notes);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    await decided.write();
    return { ok: true, message: decided.note, written: [relPath(this.dir, decided.file)] };
  }

  /**
   * The rule behind both, decided once against a fresh load: does the rung exist, and what would
   * writing it do. Never creates an outfit, a variant or a shot — a note on something that does
   * not exist is a typo, and inventing the thing would hide it.
   */
  private async artNotesPlan(
    project: LoadedProject,
    target: string,
    notes: string,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; note: string; file: string; write: () => Promise<void> }
  > {
    const parsed = parseArtTarget(target);
    if (!parsed) {
      return {
        ok: false,
        reason: `"${target}" names no art-notes rung; expected character:<id>[/<outfit>], location:<id>[/<variant>] or shot:<sceneId>/<shotId>.`,
      };
    }
    const shots = await readAllShots(project);
    const rung = rungAt(parsed, { model: project.model, shots });
    if (!rung) return { ok: false, reason: `No such art-notes rung: ${target}.` };
    const said = notes.trim()
      ? `Set art notes on ${rung.label}.`
      : `Cleared art notes on ${rung.label}.`;

    if (parsed.kind === 'shot') {
      const scene = project.model.scenes.get(parsed.sceneId)!;
      const file = project.paths.shotsFile(parsed.sceneId);
      return {
        ok: true,
        note: said,
        file,
        write: async () => {
          const loaded = await readShots(
            project.paths,
            scene.id,
            new Set(scene.lines.map((l) => l.id)),
          );
          if (!loaded) throw new Error(`Scene "${scene.id}" has no storyboard to write to.`);
          const next = loaded.shots.map((s) =>
            s.id === parsed.shotId ? withArtNotes(s, notes) : s,
          );
          await writeShots(project.paths, scene.id, next);
        },
      };
    }

    const docs =
      parsed.kind === 'character' ? project.inputs.characterDocs : project.inputs.locationDocs;
    const found = entityDoc(docs, parsed.id);
    if (!found) return { ok: false, reason: `No sheet on disk for ${parsed.kind} "${parsed.id}".` };
    return {
      ok: true,
      note: said,
      file: found.file,
      write: async () => {
        const edited =
          parsed.kind === 'character'
            ? applyCharacterEdit(found.doc, characterNotesEdit(project, parsed, notes))
            : applyLocationEdit(found.doc, locationNotesEdit(project, parsed, notes));
        if (!edited.ok) throw new Error(`Edit rejected: ${edited.diagnostic.message}`);
        await writeFileAtomic(found.file, docToMarkdown(edited.value.doc));
      },
    };
  }

  /**
   * The rule behind both concept halves, decided once against a fresh load: is there something to
   * draw, is there a root to write it into, and what would the prompt say.
   */
  private async conceptPlan(
    sentence: string,
    subject: string,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; note: string; project: LoadedProject; req: ConceptRequest }
  > {
    const said = sentence.trim();
    if (!said) return { ok: false, reason: 'Nothing to draw: the description is empty.' };
    const named = subject ? parseSubject(subject) : undefined;
    if (subject && !named) {
      return {
        ok: false,
        reason: `"${subject}" names no subject; expected location:<id> or character:<id>.`,
      };
    }
    const project = await loadProject(this.dir);
    const refusal = baseRefusal(project.store.base);
    if (refusal) return { ok: false, reason: refusal };
    const bound = named ?? matchSubject(project.model, said);
    if (bound && !subjectEntity(project.model, bound)) {
      return { ok: false, reason: `No ${bound.kind} "${bound.id}" in this project.` };
    }
    const of = bound ? `of ${formatSubject(bound)}` : 'bound to nothing in the project';
    return {
      ok: true,
      note: `Would draw a concept ${of}. It is a sketch — nothing in the pipeline plans or renders it.`,
      project,
      req: { sentence: said, ...(bound ? { subject: bound } : {}) },
    };
  }

  /** What `art.generate` would draw, without spending the call. */
  async previewConcept(
    sentence: string,
    subject: string,
  ): Promise<{ ok: boolean; message: string }> {
    const decided = await this.conceptPlan(sentence, subject);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Draw one concept image. The door the planner deliberately does not have — a sentence in, an
   * asset out, with no task node and no place in any plan. Providers come from the session's own
   * `mock`, so there is no second policy about whether this run makes real art.
   */
  async drawConcept(
    sentence: string,
    subject: string,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    const decided = await this.conceptPlan(sentence, subject);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { project, req } = decided;
    const result = await this.while('a concept image', async () => {
      const providers = await buildProviders(project, this.mock);
      return generateConcept(
        {
          config: project.config,
          model: project.model,
          store: project.store,
          image: providers.image,
        },
        req,
      );
    });
    const of = result.subject ? ` of ${formatSubject(result.subject)}` : '';
    return {
      ok: true,
      message: `Drew a concept${of}: ${result.ref.hash.slice(0, 8)}.`,
      hash: result.ref.hash,
      written: [relPath(this.dir, result.file), relPath(this.dir, project.paths.baseManifest)],
    };
  }

  /** What `art.redraw` would draw, decided from the manifest without spending the call. */
  async previewRedraw(
    hash: string,
    prompt: string,
    title: string,
  ): Promise<{ ok: boolean; message: string }> {
    const project = await loadProject(this.dir);
    const decided = redrawOf(
      project.store,
      { hash, prompt, title },
      { seeded: this.seeded(project) },
    );
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Draw a concept again, from an edited prompt or the same one. A concept is the one asset whose
   * prompt is authored rather than derived, so it is the one asset an author can rewrite; the
   * result is a new sketch beside the old one, because bytes are content-addressed.
   */
  async redrawAsset(
    hash: string,
    prompt: string,
    title: string,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    const project = await loadProject(this.dir);
    const decided = redrawOf(
      project.store,
      { hash, prompt, title },
      { seeded: this.seeded(project) },
    );
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const result = await this.while('a concept image', async () => {
      const providers = await buildProviders(project, this.mock);
      return redrawConcept(
        {
          config: project.config,
          model: project.model,
          store: project.store,
          image: providers.image,
        },
        { hash, prompt, title },
      );
    });
    const same = result.unchanged
      ? ' The same prompt and a fixed seed gave back the same picture, so nothing new was written.'
      : ` ${hash.slice(0, 8)} is still there.`;
    return {
      ok: true,
      message: `Redrew ${hash.slice(0, 8)} as ${result.ref.hash.slice(0, 8)}.${same}`,
      hash: result.ref.hash,
      written: [relPath(this.dir, result.file), relPath(this.dir, project.paths.baseManifest)],
    };
  }

  /** Whether a re-roll would come back identical — one fixed seed, one prompt, one picture. */
  private seeded(project: LoadedProject): boolean {
    return project.config.image_params.seed !== undefined;
  }

  /** What `art.promote` would do, decided from the manifest without writing anything. */
  async previewPromote(hash: string, variant: string): Promise<{ ok: boolean; message: string }> {
    const project = await loadProject(this.dir);
    const decided = promotionOf(project.store, { hash, variant });
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Promote a concept to the location plate the planner would have rendered: the variant goes onto
   * the sheet, the bytes are re-recorded as a `location_ref`, and that plate's task is logged
   * `done` so the next run adopts the sketch rather than rendering over it.
   */
  async promoteAsset(
    hash: string,
    variant: string,
    description: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const project = await loadProject(this.dir);
    const decided = promotionOf(project.store, { hash, variant });
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const result = await promoteConcept(
      { config: project.config, paths: project.paths, store: project.store },
      { hash, variant, ...(description.trim() ? { description: description.trim() } : {}) },
    );
    const added = result.addedVariant ? ` "${result.variant}" is new on its sheet.` : '';
    return {
      ok: true,
      message: `Promoted ${hash.slice(0, 8)} to the ${result.variant} plate for ${result.locationId}.${added}`,
      written: [
        ...(result.file ? [relPath(this.dir, result.file)] : []),
        relPath(this.dir, project.paths.baseManifest),
        relPath(this.dir, project.paths.tasksLog),
      ],
    };
  }

  /**
   * The sidebar's logical tree plus per-entity backlinks. One load, one manifest, one storyboard
   * read per scene — which is exactly why this is not folded into `workspace:index`, the shape
   * the agent refetches every turn.
   */
  async docTree(): Promise<DocTree> {
    const project = await loadProject(this.dir);
    this.bibleWorkspace ??= new Workspace(this.dir);
    const bible = await this.bibleWorkspace.bible();
    await bible.refresh();

    const shots = await readAllShots(project, { reportBroken: true });
    const manifest = project.store.manifest();
    return buildDocTree({
      root: this.dir,
      model: project.model,
      inputs: project.inputs,
      manifest,
      shots,
      bible: bible.files(),
      wikiDir: relPath(this.dir, project.paths.wikiDir),
      assetLabels: labelAssets(manifest, labelContext(project.model, project.graph)),
    });
  }

  /** The tree's other mode: what is actually on disk, `.git` and `node_modules` excluded. */
  async fileTree(): Promise<DocNode[]> {
    return fileTree(await walkFiles(this.dir));
  }

  /**
   * One authored document as text, with the hash it was read at. Deliberately not through
   * `@vn/bible`: that interface has no whole-file API and that absence is what keeps the bible
   * out of an agent's context window — a human reading their own note on screen is a different
   * act, and it reads the workspace directly.
   */
  readDoc(path: string): Promise<DocResult<{ file: DocFile }>> {
    return readDocFile(this.dir, path);
  }

  /** What a save would do, decided without writing — what `doc.write`'s precondition reports. */
  previewDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocWritePlan>> {
    return checkDocWrite(this.dir, path, text, seenHash, SCENE_WRITER);
  }

  /**
   * Save one document whole, and say what the model will make of it. The refusals are
   * `checkDocWrite`'s; the schema check is here because it needs `@vn/model`, which `@vn/store`
   * may not import — and because a failure there is a diagnostic beside a saved file rather than
   * a refusal, exactly the split `loadInputs` already draws.
   */
  async saveDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocSaveResult>> {
    const plan = await writeDocFile(this.dir, path, text, seenHash, SCENE_WRITER);
    if (!plan.ok) return plan;
    const diagnostic = entityDiagnostic(plan.path, plan.doc);
    return {
      ok: true,
      path: plan.path,
      hash: plan.hash,
      bytes: plan.bytes,
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  /**
   * Where a scaffolded document would land and what it would say. The character and location
   * templates are the same `newCharacterDoc` / `newLocationDoc` the agent's `create_character`
   * calls, so one authorial act has one answer and the id is derived in exactly one place. The
   * path is conventional; filing a sheet elsewhere is a move, not a different scaffolder.
   */
  private newDoc(
    kind: NewDocKind,
    name: string,
  ): { id: string; path: string; text: string } | null {
    const paths = new ProjectPaths(this.dir);
    // A note is a heading and nothing else: `wiki/` is free-form, and an empty front-matter
    // block at the top of every new note would be a shape the author has to delete.
    if (kind === 'note') {
      const id = slug(name);
      return id
        ? { id, path: relPath(this.dir, join(paths.wikiDir, `${id}.md`)), text: `# ${name}\n` }
        : null;
    }
    const doc = kind === 'character' ? newCharacterDoc(name) : newLocationDoc(name);
    const id = String(doc.data['id'] ?? '');
    if (!id) return null;
    const file = kind === 'character' ? paths.characterFile(id) : paths.locationFile(id);
    return { id, path: relPath(this.dir, file), text: docToMarkdown(doc) };
  }

  /** Would the scaffold land? Mostly: is that name already taken. */
  async previewCreate(kind: NewDocKind, name: string): Promise<DocResult<DocWritePlan>> {
    const scaffold = this.newDoc(kind, name);
    if (!scaffold) return { ok: false, reason: `"${name}" does not name a ${kind}` };
    return checkDocWrite(this.dir, scaffold.path, scaffold.text, '', SCENE_WRITER);
  }

  /**
   * Scaffold a character, a location or a wiki note from a **name**. The empty `seenHash` is what
   * makes this a creation: the write refuses over a file already there rather than overwriting
   * whatever the author had under that name.
   */
  async createDoc(
    kind: NewDocKind,
    name: string,
  ): Promise<DocResult<DocSaveResult & { id: string }>> {
    const scaffold = this.newDoc(kind, name);
    if (!scaffold) return { ok: false, reason: `"${name}" does not name a ${kind}` };
    const written = await writeDocFile(this.dir, scaffold.path, scaffold.text, '', SCENE_WRITER);
    if (!written.ok) return written;
    return {
      ok: true,
      id: scaffold.id,
      path: written.path,
      hash: written.hash,
      bytes: written.bytes,
    };
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

    const plan = planMarkerEdit(project.sources, op.edits);
    if (!plan.ok) return { ok: false, message: plan.message, written: [] };

    if (plan.patches.length === 0) {
      return {
        ok: true,
        message: `${op.message} (already wired that way — nothing written)`,
        written: [],
        graph: storyGraphOf(project.model),
      };
    }

    const files = await applyMarkerPlan(plan.patches);
    const reloaded = await loadProject(this.dir);
    return {
      ok: true,
      message: op.message,
      written: files.map((file) => relPath(this.dir, file)),
      graph: storyGraphOf(reloaded.model),
    };
  }

  /**
   * The scenes a prose edit is decided against: as their chunks parse, with cues still the ones
   * the author typed — deliberately not the model's, which resolves each cue to a character id.
   * This is what an interaction's `targets` enumerates over; a command's own `check` goes through
   * `previewSceneEdit`, which decides against this same state and prices the storyboard too.
   */
  async scriptState(): Promise<ScriptState> {
    const project = await loadProject(this.dir);
    return scriptStateOf(project.sources, project.config.start);
  }

  /**
   * A prose edit decided against a fresh load and not written — `@vn/scriptedit` owns the rules and
   * the proof; this is only the load. Shared by `previewSceneEdit` and `editScene`, so a `check`
   * reports the consequence the run produces rather than a description of one.
   */
  private async planScene(
    decide: (state: ScriptState) => LineOp,
  ): Promise<{ project: LoadedProject; plan: ScenePlan }> {
    const project = await loadProject(this.dir);
    return { project, plan: await planSceneEdit(editInputOf(project), decide) };
  }

  /** What `editScene` would do and cost the storyboard, without doing it. */
  async previewSceneEdit(
    decide: (state: ScriptState) => LineOp,
  ): Promise<{ ok: boolean; message: string }> {
    const { plan } = await this.planScene(decide);
    if (!plan.ok) return { ok: false, message: plan.message };
    return { ok: true, message: scenePlanMessage(plan) };
  }

  /**
   * The single write path for every prose edit, and the sibling of `editBranches`: apply the proved
   * plan — chunks, storyboards, removals — then rebuild the model. The app's own part is reporting:
   * `applyScenePlan` answers in absolute paths, and a `written` list is workspace-relative.
   */
  async editScene(decide: (state: ScriptState) => LineOp): Promise<SceneEditResult> {
    const { project, plan } = await this.planScene(decide);
    if (!plan.ok) return { ok: false, message: plan.message, written: [], removed: [] };

    const input = editInputOf(project);
    const paths = await applyScenePlan(input, plan);
    const written = paths.written.map((file) => relPath(this.dir, file));
    const removed = paths.removed.map((file) => relPath(this.dir, file));

    if (written.length === 0 && removed.length === 0) {
      return {
        ok: true,
        message: `${plan.message} (already reads that way — nothing written)`,
        written: [],
        removed: [],
        graph: storyGraphOf(project.model),
      };
    }
    const reloaded = await loadProject(this.dir);
    return {
      ok: true,
      message: scenePlanMessage(plan),
      written,
      removed,
      graph: storyGraphOf(reloaded.model),
    };
  }

  /**
   * The decision behind `story.moveShot`, which is the one scene edit whose *rule* needs the
   * storyboard: `planSceneEdit` hands its callback the script state and nothing else, so the shots
   * are read here and curried in. The result is an ordinary `(state) => LineOp`, so `check` and
   * `run` go through `previewSceneEdit`/`editScene` like every other prose edit.
   */
  async shotOrder(
    sceneId: string,
    shot: string,
    after: string,
  ): Promise<(state: ScriptState) => LineOp> {
    const project = await loadProject(this.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) return () => ({ ok: false, error: `No scene "${sceneId}".` });

    const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    if (!loaded) {
      return () => ({
        ok: false,
        error: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
      });
    }
    return moveShot(loaded.shots, { shot, after });
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
    const targets = sceneId ? project.sources.filter((s) => s.id === sceneId) : project.sources;
    if (sceneId && targets.length === 0) return fail(`No file holds scene "${sceneId}".`);

    let assigned = 0;
    const pending: { source: SceneSource; text: string }[] = [];
    for (const source of targets) {
      // No scene filter: a chunk holds exactly the one scene, already selected by `targets`.
      const patch = assignLineIds(source.script);
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
   * The migration `workspace.import` would perform, decided and not written: the chunks
   * `sceneChunksFromScript` proved read back as the same scenes, plus the screenplay to move
   * aside. Shared with `previewImport`, so the sentence a refused check reports is the refusal.
   */
  private async planImport(): Promise<{
    ok: boolean;
    message: string;
    chunks: SceneChunk[];
    entry: string | undefined;
    scriptPath: string | undefined;
  }> {
    const paths = new ProjectPaths(this.dir);
    const fail = (message: string) => ({
      ok: false,
      message,
      chunks: [],
      entry: undefined,
      scriptPath: undefined,
    });

    // An existing chunk is either a previous import or hand-authored work, and importing over
    // the second is the loss this refusal exists to prevent.
    const already = await readSceneChunks(paths);
    if (already.length > 0) {
      return fail(`scenes/ already holds ${already.length} chunk(s); importing would overwrite.`);
    }
    // The finder the reader uses to report the leftover, so the file complained about is the file
    // converted rather than a second opinion about which one is the screenplay.
    const scriptPath = await findScreenplay(paths);
    if (scriptPath === undefined) {
      return fail('There is no screenplay/*.fountain to import.');
    }
    const aside = `${scriptPath}.imported`;
    if (await exists(aside)) return fail(`${relPath(this.dir, aside)} already exists.`);

    const config = await loadConfig(this.dir);
    const result = sceneChunksFromScript(
      parseFountain(await readText(scriptPath)),
      config.start === undefined ? {} : { start: config.start },
    );
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) return fail(errors.map((d) => d.message).join(' '));

    const warnings = result.diagnostics.length ? ` ${result.diagnostics.length} warning(s).` : '';
    return {
      ok: true,
      message: `${result.chunks.length} scene(s) would move into scenes/.${warnings}`,
      chunks: result.chunks,
      entry: result.entry,
      scriptPath,
    };
  }

  /** What `importScreenplay` would do, without doing it. */
  async previewImport(): Promise<{ ok: boolean; message: string }> {
    const { ok, message } = await this.planImport();
    return { ok, message };
  }

  /**
   * Convert a `screenplay/*.fountain` project into one chunk per scene — the `vngen import`
   * equivalent. The screenplay is moved aside rather than deleted, and **last**: while it is still
   * a `.fountain` the project reports it on every load, so the rename is what finishes the import.
   */
  async importScreenplay(): Promise<{ ok: boolean; message: string; written: string[] }> {
    const plan = await this.planImport();
    if (!plan.ok || plan.scriptPath === undefined) {
      return { ok: false, message: plan.message, written: [] };
    }

    const paths = new ProjectPaths(this.dir);
    const written: string[] = [];
    for (const chunk of plan.chunks) {
      await writeSceneChunk(paths, chunk.id, chunk.doc);
      written.push(relPath(this.dir, paths.sceneFile(chunk.id)));
    }
    // A directory has no document order, so the entry the screenplay implied is written down.
    if (plan.entry !== undefined && (await setStartScene(this.dir, plan.entry))) {
      written.push(relPath(this.dir, paths.projectConfig));
    }
    const aside = `${plan.scriptPath}.imported`;
    await rename(plan.scriptPath, aside);
    written.push(relPath(this.dir, aside));

    return {
      ok: true,
      message:
        `Imported ${plan.chunks.length} scene(s) into scenes/; the screenplay is now ` +
        `${relPath(this.dir, aside)} — delete it once you are satisfied.`,
      written,
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
    const wardrobes = wardrobesOf(project.model.characters);
    // Whoever the scene declares, plus anyone a shot actually frames — a subject the scene's
    // `characters` list forgot is still someone the strip has to be able to dress.
    const cast = new Set([
      ...scene.characters,
      ...(loaded?.shots ?? []).flatMap((s) => s.subjects.map((sub) => sub.characterId)),
    ]);
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
        // Only the subjects that state one: the strip resolves the rest through `outfitFor`,
        // and a map that pre-filled the inherited answer would erase the distinction.
        outfits: Object.fromEntries(
          s.subjects.filter((sub) => sub.outfit).map((sub) => [sub.characterId, sub.outfit!]),
        ),
        coversLines: s.coversLines,
        status: s.status,
        ...(s.image ? { image: { hash: s.image, ext: exts.get(s.image) ?? 'png' } } : {}),
        // Against `scene` as just loaded, so an edit made anywhere — this app, the CLI, the
        // agent, a hand-edit — shows up the next time the strip is read.
        drift: driftOf(scene, s),
      })),
      // A character with no sheet has no wardrobe to offer, so it gets no row rather than a
      // control whose every option the command would refuse.
      cast: [...cast].flatMap((id) => {
        const wardrobe = wardrobes.get(id);
        if (!wardrobe) return [];
        const marked = scene.outfits?.[id];
        return [{ id, ...wardrobe, ...(marked ? { marked } : {}) }];
      }),
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

  /**
   * The scene-marker outfit rule against a fresh load: the wardrobes it is checked against and the
   * scenes it would be decided over, from the same read. `decide` is handed to `editBranches`
   * rather than run here, so the patch sees the scenes the rule saw.
   */
  private async sceneOutfitRule(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<{
    project: LoadedProject;
    decide: (scenes: Map<string, Scene>) => SceneOutfitOp;
  }> {
    const project = await loadProject(this.dir);
    const wardrobes = wardrobesOf(project.model.characters);
    return {
      project,
      decide: (scenes) => setSceneOutfit(scenes, wardrobes, { scene: sceneId, character, outfit }),
    };
  }

  /** The decision behind `story.setSceneOutfit`, curried for `editBranches` like `shotOrder`. */
  async sceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<(scenes: Map<string, Scene>) => SceneOutfitOp> {
    return (await this.sceneOutfitRule(sceneId, character, outfit)).decide;
  }

  /**
   * What `story.setSceneOutfit` would do, discarded. It does not go through the story graph the
   * other branch checks preview against: that projection carries edges and reachability, and the
   * marker set it would have to answer about is not in it.
   */
  async previewSceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<SceneOutfitOp> {
    const { project, decide } = await this.sceneOutfitRule(sceneId, character, outfit);
    return decide(project.model.scenes);
  }

  /** The shot-override rule against a fresh load, shared by the preview and the write. */
  private async shotOutfitRule(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    const project = await loadProject(this.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

    const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    if (!loaded) {
      return {
        project,
        op: {
          ok: false,
          error: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
        },
      };
    }
    const wardrobes = wardrobesOf(project.model.characters);
    return {
      project,
      op: setShotOutfit(loaded.shots, scene, wardrobes, { shot: shotId, character, outfit }),
    };
  }

  /** What `story.setOutfit` would do, without writing it. */
  async previewShotOutfit(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<ShotOutfitOp> {
    return (await this.shotOutfitRule(sceneId, shotId, character, outfit)).op;
  }

  /**
   * Override what one subject of one shot wears, or clear the override. The third writer of
   * `work/shots/<sceneId>.json`, beside `setCoverage` and `editScene` — and unlike either of them
   * this changes the shot's prompt, so the shot re-hashes and the next run re-renders it.
   */
  async setShotOutfit(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.shotOutfitRule(sceneId, shotId, character, outfit);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok: true,
      message: op.message,
      written: [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.sceneCoverage(sceneId),
    };
  }

  /** Build the playable live from the current model + asset store (no file needed). */
  async playable(): Promise<Playable> {
    const project = await loadProject(this.dir);
    const shots = await loadSceneShots(project.paths, project.model);
    return buildPlayable(project.model, project.store, {
      shots,
      portraitOverlay: project.config.portrait_overlay,
    });
  }

  /** Write the playable to `vngen/build/story.play.json` — the `vngen export` equivalent. */
  async exportPlayable(): Promise<{ path: string; scenes: number }> {
    const project = await loadProject(this.dir);
    const shots = await loadSceneShots(project.paths, project.model);
    const playable = buildPlayable(project.model, project.store, {
      shots,
      portraitOverlay: project.config.portrait_overlay,
    });
    await writeFileAtomic(project.paths.storyPlay, JSON.stringify(playable, null, 2) + '\n');
    return { path: project.paths.storyPlay, scenes: Object.keys(playable.scenes).length };
  }

  /**
   * Project the scenes back into one Fountain screenplay at the project root — the `vngen
   * screenplay` equivalent. Never into `screenplay/`, which is a second source of truth for every
   * scene; `clean` drops the `[[…]]` markers and with them the scene ids, the branches and
   * `nextLineId`, so that output is a reading copy and not an input.
   */
  async writeScreenplay(clean: boolean): Promise<{
    ok: boolean;
    message: string;
    written: string[];
  }> {
    const project = await loadProject(this.dir);
    if (project.model.scenes.size === 0) {
      return { ok: false, message: 'There is no scene to write.', written: [] };
    }
    const file = join(this.dir, 'screenplay.fountain');
    await writeFileAtomic(file, scriptFromScenes(project.model, { clean }));
    return {
      ok: true,
      message: `Wrote ${project.model.scenes.size} scene(s) to screenplay.fountain${
        clean ? ' (clean: markers dropped, so it cannot be imported back)' : ''
      }.`,
      written: [relPath(this.dir, file)],
    };
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
    // The whole method, loads included: `busy()` has to be true from the call, not from the
    // moment the scheduler starts, or a switch could land in the gap.
    const summary = await this.while('a pipeline run', async () => {
      const project = await loadProject(this.dir);
      const providers = await buildProviders(project, mock);
      return runPipeline({
        model: project.model,
        graph: project.graph,
        store: project.store,
        providers,
        config: project.config,
        paths: project.paths,
        dryRun: mock,
        now: () => new Date().toISOString(),
      });
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
      failed: summary.failed.length,
      failures: summary.failed.map((t) => ({ hash: t.hash, kind: t.kind, error: t.error })),
    };
  }
}
