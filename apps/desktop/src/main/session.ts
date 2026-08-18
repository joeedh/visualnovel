/**
 * One workspace's worth of backend state, owned by the Electron main process. This is the
 * desktop app's join point: it embeds BOTH the authoring agent (`@vn/authoring`) and the
 * generative scheduler (`@vn/scheduler`) in-process and exposes them as plain async methods
 * the IPC layer can call. The glue mirrors `apps/authoring/src/agent.ts` (agent assembly)
 * and `apps/cli/src/project.ts` (project + provider construction); it is intentionally not
 * imported from those apps, which aren't libraries.
 */
import {
  CONFIG_FILENAME,
  loadConfig,
  resolveKeys,
  secretDirsFor,
  secretFileFor,
  setArtStyle,
  setStartScene,
  type ProjectConfig,
  type ResolvedKeys,
} from '@vn/config';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { openGit } from '@vn/git';
import {
  applyCharacterEdit,
  applyLocationEdit,
  assignLineIds,
  characterFromDoc,
  docToMarkdown,
  headingOf,
  locationFromDoc,
  modelFromInputs,
  newCharacterTemplate,
  newLocationDoc,
  sceneChunksFromScript,
  scriptFromScenes,
  slug,
  variantEntries,
  wardrobeEntries,
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
import { exists, readText, sha256, writeFileAtomic } from '@vn/util';
import {
  baseRefusal,
  decomposeAll,
  decomposeAllPreview,
  driftOf,
  gateStatus,
  isApproved,
  type DecomposeAllResult,
} from '@vn/pipeline';
import {
  adopt,
  adoptSlot,
  adoptionForSlot,
  adoptionOf,
  artNotesOf,
  artSeedOf,
  assetPrereqs,
  assetSlotLabel,
  buildSlotGraph,
  composePrompt,
  condensePrompt,
  coverage,
  cycleRefusal,
  effectiveChunks,
  enabledChunks,
  formatSubject,
  generateConcept,
  matchSubject,
  overrideAt,
  parseSlot,
  parseSubject,
  prereqRefusal,
  promoteConcept,
  promotionOf,
  redrawConcept,
  redrawOf,
  refCycle,
  refDrift,
  renderPrompt,
  resolveBinding,
  rungOf,
  rungsFor,
  setArtNotes as writeArtNotes,
  setArtSeed as writeArtSeed,
  slotKey,
  slotLabel,
  slotOf,
  subjectEntity,
  suspensionMap,
  uploadOf,
  uploadReference,
  type AdoptSlotPlan,
  type ConceptRequest,
  type PromptRung,
  type Suspension,
} from '@vn/artgen';
import { chatBackendFor, chatVendorFor, createMockProviders, createProviders } from '@vn/providers';
import {
  Agent,
  NativeAgentBackend,
  StructuredAgentBackend,
  Workspace,
  archiveUpload,
  PROJECT_SKILLS_DIR,
  composeSystem,
  discoverSkills,
  focusOnScene,
  loadContext,
  newSkillTemplate,
  skillId,
  skillRoots,
  systemSections,
  workspaceArtGen,
  type AgentBackend,
  type AgentEvent,
  type AgentMode,
  type AskChoices,
  type GeneratedContextState,
  type GeneratedCounts,
  type Permission,
  type Plan,
  type PlanDecision,
  type RunResult,
  type ToolContext,
  type UploadBatch,
  type WorkspaceIndex,
} from '@vn/authoring';
import type { Excerpt } from '@vn/bible';
import { runPipeline, type RunSummary } from '@vn/scheduler';
import { buildPlayable, loadSceneShots } from '@vn/export';
import {
  moveShot,
  setSceneOutfit,
  setShotOutfit,
  wardrobesOf,
  type BranchOp,
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
import type {
  AnyTask,
  Asset,
  AssetKind,
  EffortChoice,
  LocationVariant,
  Outfit,
  Playable,
  ProjectModel,
  PromptChunk,
  PromptOverride,
  Providers,
  RefBinding,
  Scene,
  Shot,
  TaskInputs,
  TextLLM,
} from '@vn/types';
import {
  DEFAULT_BUDGET,
  DEFAULT_EFFORT,
  EFFORT_CHOICES,
  bindsTo,
  resolveEffort,
  type BudgetChoice,
  type TaskKind,
} from '@vn/types';
import {
  assertIssueUrl,
  fitBody,
  issueUrl,
  renderReport,
  reportTitle,
  sourceRoot,
  type Redactor,
  type Report,
} from '@vn/agentreport';
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
  ProjectView,
  SceneCoverage,
  SceneEditResult,
  StoryGraph,
} from '../shared/ipc.js';
import { notify } from './notifications.js';
import { narrowTask } from './reviews.js';
import { labelAssets, labelContext } from './assetlabel.js';
import { deriveChunks, derivePrompt } from './assetprompt.js';
import { applyPromptEdit, type PromptEdit } from './promptedit.js';
import { DEFAULT_CAP, buildDocTree, fileTree, type SkillEntry } from './doctree.js';
import { storyGraphOf } from './storygraph.js';
import { renameInText } from './rename.js';
import { confirmDetail } from './toolconfirm.js';
import { ensureIgnored } from './workspace.js';
import {
  answered,
  answeredQuestion,
  asked,
  decided,
  emptyConvo,
  proposed,
  queried,
  received,
  type Convo,
} from '../shared/convo.js';
import {
  appendItem,
  listThreads,
  openThread,
  readThread,
  retitleThread,
  titleFrom,
  type ThreadHeader,
  type ThreadRecord,
} from './threads.js';
import type { ChunkRefInfo, PromptView } from '../shared/prompt.js';
import { setCoverage } from '../shared/coverage.js';
import { adviseRun, analysisEffort } from '../shared/advice.js';
import { NO_SOURCE, analyseThread, makeRedactor, saveReport } from './agentreport.js';

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

/** Hooks the session uses to reach the renderer: events out, and the three permission doors. */
export interface SessionDeps {
  emitEvent(event: AgentEvent): void;
  requestPlan(plan: Plan): Promise<PlanDecision>;
  /**
   * The author's answer to a clarifying question. Empty is an answer — silence, said out loud.
   * `choices` is a shortlist the card offers to click; what comes back is a string regardless.
   */
  requestAnswer(question: string, choices?: AskChoices): Promise<string>;
  /** Yes or no to an always-confirm tool. `detail` is the English sentence the card reads out. */
  requestConfirm(tool: string, detail: string): Promise<boolean>;
  /** The app build, so a bug report names the code a maintainer should read. Absent in tests. */
  appVersion?: string;
  /**
   * Where the app may keep files that are the *app's*, not the author's — a drafted bug report,
   * cached provider docs. Deliberately not under the project: neither belongs in its history.
   */
  userData?: string;
  /**
   * Hand a URL to the OS, and put text on the clipboard. Both are Electron's, so they arrive as
   * functions rather than as an import — this file is typechecked and tested with no app around
   * it. Absent means no browser: `report.openIssue` says so rather than reporting a success.
   */
  openExternal?(url: string): Promise<void>;
  writeClipboard?(text: string): void;
  /**
   * Tell the window what long-running work is in flight. Not routed through the command host:
   * the effect is pushed *while* a command is still running, which is exactly when that host
   * has not returned an outcome to attach anything to.
   */
  pushBusy(state: { what?: string; ran: number; pending: number }): void;
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

/**
 * The task kinds that render a picture — every one whose prompt opens with the project's art
 * style, and so exactly the set a change to it re-keys. `vision_review` and `prompt_refine` read
 * a prompt but never carry the preamble.
 */
const IMAGE_KINDS = new Set<TaskKind>([
  'location_ref',
  'portrait',
  'model_sheet',
  'outfit_sheet',
  'shot_image',
]);

/** Workspace-relative and forward-slashed, which is what a `written` list reports. */
function relPath(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}

/**
 * The kinds `previewAccept` does not refuse outright. A portrait belongs to the gate, a concept is
 * consumed by nothing and an upload was never generated — so none of the three has an approval to
 * withhold, and asking about their upstream would be a refusal with no act behind it.
 */
const ACCEPTABLE = new Set<AssetKind>([
  'location_ref',
  'model_sheet',
  'outfit_sheet',
  'shot_image',
]);

/**
 * Which assets are suspended, keyed by hash. One walk answers both the listing and the one-asset
 * question, so a pane and `asset.suspended` can never disagree about a reason.
 */
function suspensionsOf(
  project: LoadedProject,
  shots: ReadonlyMap<string, Shot[] | null>,
): Map<string, Suspension> {
  return suspensionMap({
    ...labelContext(project.model, project.graph),
    assets: project.store.manifest(),
    shots,
  });
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

/** An outfit with one field changed, in the shape `wardrobeEntries` re-serializes. */
function withOutfit(outfit: Outfit, patch: Partial<Outfit>): Outfit {
  const next = { ...outfit, ...patch };
  if (!next.artNotes) delete next.artNotes;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/** The same for a variant. */
function withVariant(variant: LocationVariant, patch: Partial<LocationVariant>): LocationVariant {
  const next = { ...variant, ...patch };
  if (!next.artNotes) delete next.artNotes;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/** A shot with its prompt override set, or removed when the edit settled on nothing. */
function withPromptOverride(shot: Shot, override: PromptOverride | undefined): Shot {
  const { promptOverride: _drop, ...rest } = shot;
  return override ? { ...rest, promptOverride: override } : rest;
}

/**
 * The character edit one rung's worth of prompt override amounts to — {@link characterNotesEdit}
 * with the other field. A character rung has no wardrobe to resend, but it does have to say
 * "nothing here" out loud: an empty override is what `overrideData` turns into a removed key.
 */
function characterOverrideEdit(
  project: LoadedProject,
  rung: Extract<PromptRung, { kind: 'character' | 'outfit' }>,
  override: PromptOverride | undefined,
): CharacterEdit {
  if (rung.kind === 'character') return { promptOverride: override ?? { mode: 'chunks' } };
  const character = project.model.characters.get(rung.characterId)!;
  return {
    outfits: wardrobeEntries(
      character.outfits.map((o) =>
        o.id === rung.outfit ? withOutfit(o, { promptOverride: override }) : o,
      ),
    ),
  };
}

/** The same for a location variant. */
function locationOverrideEdit(
  project: LoadedProject,
  rung: Extract<PromptRung, { kind: 'variant' }>,
  override: PromptOverride | undefined,
): LocationEdit {
  const location = project.model.locations.get(rung.locationId)!;
  return {
    variants: variantEntries(
      location.variants.map((v) =>
        v.id === rung.variant ? withVariant(v, { promptOverride: override }) : v,
      ),
    ),
  };
}

/** Why an asset of this kind has no chunks to edit — the sentence `PromptView.frozen` carries. */
function frozenReason(kind: AssetKind): string {
  return kind === 'concept'
    ? 'A concept’s prompt was typed, not derived, so it has no chunks. art.redraw rewrites it.'
    : 'The project no longer describes this asset, so its prompt cannot be re-derived.';
}

/** What a chunk edit does to one clause — `prompt.setChunk`'s `op`. */
export type ChunkOp = 'replace' | 'append' | 'mute' | 'clear';

/** Which half of an override `prompt.clear` discards. */
export type ClearPart = 'all' | 'chunks' | 'order' | 'custom' | 'agent';

/** What a prompt preview answers: would this be allowed, and what would it say. */
export interface PromptResult {
  ok: boolean;
  message: string;
}

/**
 * What the report dialog asked for, before anything about it has been resolved. Every string may
 * be empty, and empty means the default — the newest conversation, the bound model, the bound
 * effort stepped up.
 */
export interface ReportAsk {
  thread: string;
  note: string;
  source: boolean;
  model: string;
  effort: string;
}

/** A finished analysis: the findings, the markdown they render to, and where a copy was kept. */
export interface ReportDraft {
  report: Report;
  /** The issue title, `AGENTREPORT:`-prefixed, so the preview does not re-derive one. */
  title: string;
  body: string;
  /** Absent when there was nowhere to write one, or the write failed. */
  file?: string;
}

/** Where `report.openIssue` sent the author, and whether the report had to be cut to fit. */
export interface IssueOpened {
  url: string;
  truncated: boolean;
}

/**
 * The refusal a leak earns, naming the first one. Only the first: the author fixes them one at a
 * time and the scan re-runs on every keystroke, so a list of six would be five sentences that stop
 * being true as soon as the first edit lands.
 */
function leakSentence(leaked: readonly string[]): string {
  const rest = leaked.length - 1;
  const more = rest > 0 ? ` (and ${rest} other${rest === 1 ? '' : 's'})` : '';
  return `“${leaked[0]}”${more} is still in the report — take it out before filing.`;
}

/** The same, plus the files a write touched — the shape every `prompt.*` mutator returns. */
export interface PromptWriteResult extends PromptResult {
  written: string[];
}

/**
 * Directories no file tree of a project should ever show, and the walk's cap. `.vnstudio` holds
 * the layout templates — the View menu is where those are named, and a JSON mesh is not a
 * document anyone opens in an editor.
 */
const TREE_SKIP = new Set(['.git', 'node_modules', '.vnstudio']);

/** Who owns `scenes/**` from this side of the app — the sentence a refused whole-file save gets. */
const SCENE_WRITER = 'story.*';

/** The four things `doc.create` scaffolds. A note is a title and nothing else. */
export type NewDocKind = 'character' | 'location' | 'note' | 'skill';

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

/** The four directories the project map is derived from — a write to any of them dates it. */
const MAPPED_DIRS = ['characters/', 'locations/', 'scenes/', 'wiki/'];

/** Whether a finished turn wrote anything the project map is built out of. */
function wroteAuthoredInput(events: readonly AgentEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === 'tool' &&
      (e.result.written ?? []).some((p) => MAPPED_DIRS.some((dir) => p.startsWith(dir))),
  );
}

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
  /** The reasoning the backend is built with. A stated default, never the vendor's. */
  effort: EffortChoice = DEFAULT_EFFORT;
  /**
   * What one turn may spend, in non-cached tokens. Unlike the model and the effort this is not
   * something the backend is built with — it is the loop's own meter — so setting it rebuilds
   * nothing and works under `--mock` like anything else the loop decides.
   */
  budget: BudgetChoice = DEFAULT_BUDGET;

  /** What long-running work is in flight, by name; empty when the session is idle. */
  private readonly inFlight = new Set<string>();
  /** How the work above is going, as the scheduler last reported it. Zeroed when it ends. */
  private progress = { ran: 0, pending: 0 };
  /** Set for as long as a pipeline run is interruptible; `stopPipeline` is the one caller. */
  private cancel: AbortController | undefined;

  /**
   * The conversation as main sees it, reduced by the functions the renderer runs — so what is
   * written down and what is on screen are derived from one definition rather than two.
   */
  private convo: Convo = emptyConvo('');
  /** The thread being written to. Opened by the first turn, never by opening the app. */
  private thread: ThreadHeader | undefined;
  /**
   * Ids for the plan and question cards main reduces for the transcript. They are inert here —
   * the card the author clicks is the renderer's — but the reducers are shared, so they are given
   * distinct ones rather than a repeated zero.
   */
  private cardSeq = 1;
  /**
   * Whether the project map is owed a rewrite before the next turn reads it. True to begin with,
   * because a workspace that was never mapped is the common case — `examples/test4` has no
   * `AICONTEXT.generated.md` and never did, so every thread re-derived the cast from searches.
   */
  private mapStale = true;
  /**
   * Appends, in order. Half the calls that add a transcript line happen inside a synchronous
   * `onEvent`, so the writes queue behind one promise instead of racing; `runAgent` waits it out
   * before returning, which is what makes the file complete the moment a turn is.
   */
  private writes: Promise<void> = Promise.resolve();
  /**
   * The redactor the last report was written with, kept so the leak scan runs against the same
   * pseudonym table rather than a freshly built one — a different table is a different set of
   * names, and the question being asked is whether *this* report still says one.
   */
  private redaction: Redactor | undefined;

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

  /** What `busy()` says, plus how far along it is — the shape the window is pushed. */
  busyState(): { what?: string; ran: number; pending: number } {
    const what = this.busy();
    return { ...(what ? { what } : {}), ...this.progress };
  }

  /** Push {@link busyState} to the window. Called on both edges, and on every step between. */
  private announceBusy(): void {
    this.deps.pushBusy(this.busyState());
  }

  private async while<T>(what: string, run: () => Promise<T>): Promise<T> {
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
   * Ask the pipeline run in flight to stop. It stops at a task boundary, so this returns what
   * was asked rather than what happened — the run's own outcome says that.
   */
  stopPipeline(): boolean {
    if (!this.cancel) return false;
    this.cancel.abort();
    return true;
  }

  /**
   * Ask the agent turn in flight to end. Same contract as {@link stopPipeline}: the step in
   * progress finishes, so the transcript stays complete and the next turn reads a whole one.
   */
  stopAgent(): boolean {
    if (this.busy() !== 'an agent turn' || !this.agent) return false;
    this.agent.stop();
    return true;
  }

  /**
   * All three doors route to the renderer. None of them may answer for the author: an
   * auto-allowed `confirmAction` spends an image call the author never agreed to, and an `ask`
   * that resolves to nothing still reports `User answered:` to the model, which then proceeds on
   * whatever it guessed — silence that reads as consent, twice over.
   */
  private permission(): Permission {
    return {
      // A plan and its verdict are the decisive turns of a conversation and neither reaches the
      // loop's event stream as a transcript line — so both are recorded here, at the seam that
      // asks. The renderer runs the same two reducers on its own copy.
      approvePlan: async (plan) => {
        const id = this.cardSeq++;
        this.record((convo) => proposed(convo, { id, plan }));
        const decision = await this.deps.requestPlan(plan);
        this.record((convo) => decided(convo, decision));
        return decision;
      },
      confirmAction: (tool, args) => this.deps.requestConfirm(tool, confirmDetail(tool, args)),
      // The author's answer is the one turn of theirs that never passes through `run`, and the
      // loop does not emit it — so a transcript that did not record it here would lose it. The
      // question goes down with it, options and all: "the second one" is unreadable without the
      // list it picked from. A declined confirmation needs no such care: that is a `blocked` event.
      ask: async (question, choices) => {
        const id = this.cardSeq++;
        const list = choices ? { choices: choices.options, multi: choices.multi } : {};
        this.record((convo) => queried(convo, { id, question, ...list }));
        const answer = await this.deps.requestAnswer(question, choices);
        this.record((convo) => answeredQuestion(convo, answer));
        return answer;
      },
    };
  }

  /**
   * Reduce the conversation, and write whatever that added to the active thread. Returns nothing
   * and never throws: a transcript that cannot be appended to is worth a warning, not a failed
   * turn — the work the conversation was about has already happened.
   */
  private record(reduce: (convo: Convo) => Convo): void {
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
   * The backend for the next turn. Native when the resolved chat backend can hold a conversation,
   * which is the cached path; the text path otherwise.
   *
   * The probe is `chatConversation` and deliberately not `chatWithTools`: Gemini implements the
   * latter, and moving it onto the native path would give it a larger tools block for a request
   * that is still single-shot and still caches nothing.
   */
  private async buildBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    if (this.mock) return new MockAgentBackend();
    const modelId = model ?? config.models.text;
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(this.dir),
      require: [chatVendorFor(modelId)],
    });
    const chat = chatBackendFor(modelId, keys, this.effort).backend;
    return chat.chatConversation ? new NativeAgentBackend(chat) : new StructuredAgentBackend(chat);
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
      // The capability `vnauthor` does not have: the same two calls `asset.regenerate` makes, so
      // an agent-started re-render takes the busy flag a pipeline run takes.
      pipeline: {
        regenerate: (hash) => this.regenerateAsset(hash),
        run: async () => {
          const result = await this.runPipeline(this.mock);
          return { ran: result.ran, failed: result.failed, blockedOnGate: result.blockedOnGate };
        },
      },
    };
    const context = await loadContext(this.dir);
    const config = await loadConfig(this.dir);
    this.model = config.models.text;
    this.agent = new Agent({
      backend: await this.buildBackend(config),
      ctx,
      permission: this.permission(),
      system: composeSystem(context),
      budget: this.budget,
      onEvent: (event) => {
        this.record((convo) => received(convo, event));
        this.deps.emitEvent(event);
      },
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
   * Rewrite the map if a turn made it wrong, before the next turn is composed. It never throws:
   * a file at that path the generator did not write is somebody's own note, and the answer to
   * that is to leave it alone and say so — not to fail the turn it was about to help.
   */
  private async refreshProjectMap(): Promise<void> {
    if (!this.mapStale) return;
    this.mapStale = false;
    try {
      await this.writeGeneratedContext();
    } catch (err) {
      console.warn(`[vnstudio] could not rewrite the project map: ${String(err)}`);
    }
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

  /**
   * One turn. `scene` is what the author had on screen when they hit send — resolved here against
   * the project rather than trusted, so a selection that has since been deleted contributes
   * nothing instead of a sentence about a scene that is gone.
   */
  async runAgent(input: string, scene?: string): Promise<RunResult> {
    return this.while('an agent turn', async () => {
      const agent = await this.ensureAgent();
      await this.refreshProjectMap();
      // The project map is a file, and this session outlives every rewrite of it — including the
      // agent's own `update_context`. Re-read it per turn so the map above the tool output is not
      // an older, more authoritative-looking answer than the tools give. Section by section, so a
      // rewritten map supersedes itself in a message rather than invalidating the cached prefix.
      agent.refreshSystem(systemSections(await loadContext(this.dir)));
      const focus = scene ? focusOnScene(await this.index(), scene) : undefined;
      await this.beginThread(input);
      this.record((convo) => asked(convo, input));
      try {
        const result = await agent.run(input, focus);
        this.record((convo) => answered(convo, result.final));
        if (wroteAuthoredInput(result.events)) this.mapStale = true;
        return result;
      } finally {
        // The turn is not over until what it said is on disk; a crash a moment later must not
        // take the answer with it.
        await this.writes;
      }
    });
  }

  /**
   * Make sure there is a thread to write to. Because only a turn opens one, the first thing the
   * author said is already known when the header is written and can be its title outright — the
   * provisional title is what a thread keeps only until someone talks in it.
   *
   * A thread that cannot be opened costs a warning and nothing else: a project on a read-only
   * volume is one you can still think in.
   */
  private async beginThread(input: string): Promise<void> {
    if (this.thread) return;
    const paths = new ProjectPaths(this.dir);
    const commit = await openGit(this.dir)
      .head()
      .catch(() => null);
    try {
      this.thread = await openThread(paths, {
        title: titleFrom(input),
        ...(commit === null ? {} : { commit }),
        ...(this.model === '' ? {} : { model: this.model }),
      });
    } catch (err) {
      console.warn(`[vnstudio] could not start a conversation thread: ${String(err)}`);
    }
  }

  async setMode(mode: AgentMode): Promise<AgentMode> {
    const agent = await this.ensureAgent();
    agent.setMode(mode);
    return agent.currentMode;
  }

  /**
   * Hot-swap the text model and rebuild the backend, preserving conversation state. The bound
   * effort is stepped down to what the new model offers — `xhigh` is not a level Sonnet 4.6
   * takes — so nothing downstream shows a setting the wire will not carry.
   */
  async setModel(modelId: string): Promise<string> {
    this.model = modelId;
    this.effort = resolveEffort(modelId, this.effort) ?? this.effort;
    if (this.mock) return modelId;
    const agent = await this.ensureAgent();
    agent.setBackend(await this.buildBackend(await loadConfig(this.dir), modelId));
    return modelId;
  }

  /**
   * Hot-swap the reasoning setting the same way. A model that honours none keeps the setting
   * anyway — `supportsEffort` is what a surface greys out on, and the backend simply omits the
   * knob — so switching back to a model that does needs no second gesture.
   */
  async setEffort(effort: EffortChoice): Promise<EffortChoice> {
    this.effort = effort;
    if (this.mock) return effort;
    const agent = await this.ensureAgent();
    agent.setBackend(await this.buildBackend(await loadConfig(this.dir), this.model || undefined));
    return effort;
  }

  /**
   * The turn ceiling. Nothing is rebuilt and nothing is awaited beyond the agent existing: the
   * budget is read by the loop at each step, so a change lands on the turn in flight too.
   */
  async setBudget(budget: BudgetChoice): Promise<BudgetChoice> {
    this.budget = budget;
    (await this.ensureAgent()).setBudget(budget);
    return budget;
  }

  /**
   * Start over. The thread is closed rather than deleted — a conversation that happened stays on
   * disk, and the next turn opens a new one.
   */
  async clearAgent(): Promise<void> {
    (await this.ensureAgent()).clear();
    await this.writes;
    this.thread = undefined;
    this.convo = emptyConvo('');
  }

  /**
   * Copy the author's own documents into `archive/`, verbatim. The rule lives in `@vn/authoring`
   * so the REPL's `/upload` and this land in the same place; the session only supplies the root.
   */
  async uploadFiles(files: string[]): Promise<UploadBatch> {
    return archiveUpload(new Workspace(this.dir), files);
  }

  /** Every saved conversation in this project, newest first, and which one is being written to. */
  async threads(): Promise<{ threads: ThreadHeader[]; active?: string }> {
    const threads = await listThreads(new ProjectPaths(this.dir));
    return { threads, ...(this.thread ? { active: this.thread.id } : {}) };
  }

  /**
   * A saved conversation, for reading. It ends the live one — the model is *not* shown what comes
   * back, so leaving the previous turns in its context while the screen shows somebody else's
   * would be the one arrangement in which neither the author nor the agent knows what is being
   * talked about.
   */
  async openThreadForReading(id: string): Promise<ThreadRecord> {
    const record = await readThread(new ProjectPaths(this.dir), id);
    await this.clearAgent();
    return record;
  }

  /** Rename a thread; an empty id means the one being written to. Refuses when there is none. */
  async renameThread(id: string, title: string): Promise<ThreadHeader> {
    const target = id.trim() === '' ? this.thread?.id : id.trim();
    if (!target) throw new Error('no conversation is open — name one to rename it');
    const named = title.trim();
    if (!named) throw new Error('a conversation needs a name');

    const paths = new ProjectPaths(this.dir);
    const { items: _items, ...header } = await readThread(paths, target);
    await retitleThread(paths, target, named);
    if (this.thread?.id === target) this.thread = { ...this.thread, title: named };
    return { ...header, title: named };
  }

  /**
   * The model and effort one analysis runs at. An empty field means *whatever the agent is bound
   * to* — so a scripted `report.agent(thread='t3')` does the sensible thing without naming a
   * model, and the dialog seeds both explicitly when a person opens it.
   *
   * Nothing here is written back: the analysis borrows the binding for one run, and an author who
   * switches to Opus to read a bad conversation has not rebound their agent.
   */
  private analysisBinding(
    config: ProjectConfig,
    ask: ReportAsk,
  ): { modelId: string; effort?: EffortChoice } {
    const modelId = ask.model.trim() || this.model || config.models.text;
    const asked = ask.effort.trim();
    const chosen = (EFFORT_CHOICES as readonly string[]).includes(asked)
      ? (asked as EffortChoice)
      : undefined;
    const effort = chosen ? resolveEffort(modelId, chosen) : analysisEffort(modelId, this.effort);
    return { modelId, ...(effort ? { effort } : {}) };
  }

  /** The conversation an analysis would read: the one named, else the newest. */
  private async reportTarget(
    ask: ReportAsk,
  ): Promise<{ ok: false; message: string } | { ok: true; header: ThreadHeader }> {
    const { threads } = await this.threads();
    const newest = threads[0];
    if (!newest) {
      return { ok: false, message: 'No conversations have been recorded in this project yet.' };
    }
    const wanted = ask.thread.trim() || newest.id;
    const header = threads.find((t) => t.id === wanted);
    return header ? { ok: true, header } : { ok: false, message: `No conversation ${wanted}.` };
  }

  /**
   * What `report.agent` would do, without spending anything on it. Every refusal is a sentence a
   * disabled control shows verbatim, and the key one is keyed to the *chosen* model — switching
   * the dropdown from a Claude id to a Gemini one changes which key has to be there. It names the
   * vendor and the command that sets it, never a value.
   */
  async previewReport(ask: ReportAsk): Promise<PromptResult> {
    if (this.mock) {
      return {
        ok: false,
        message:
          'Not while this workspace is running with mock providers — a real model has to read ' +
          'the conversation.',
      };
    }

    const target = await this.reportTarget(ask);
    if (!target.ok) return target;

    const config = await loadConfig(this.dir);
    const { modelId, effort } = this.analysisBinding(config, ask);
    const vendor = chatVendorFor(modelId);
    const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(this.dir) });
    if (!keys[vendor]?.trim()) {
      return { ok: false, message: `No ${vendor} key is set — use Provide Model Key… first.` };
    }

    if (ask.source && !(await sourceRoot())) return { ok: false, message: NO_SOURCE };

    const advice = adviseRun(modelId, effort ?? this.effort, ask.source, this.effort);
    return {
      ok: true,
      message: `Reads “${target.header.title}” with ${modelId}.${advice ? ` ${advice}` : ''}`,
    };
  }

  /**
   * Analyse a conversation that went wrong. Long — a minute or two, more with the source — so it
   * takes the busy flag every other long act does, and the dialog closes rather than being held
   * open across it.
   */
  async reportAgent(ask: ReportAsk): Promise<ReportDraft> {
    const target = await this.reportTarget(ask);
    if (!target.ok) throw new Error(target.message);

    const project = await loadProject(this.dir);
    const { modelId, effort } = this.analysisBinding(project.config, ask);
    const keys = await resolveKeys(project.config, {
      secretsDirs: await secretDirsFor(this.dir),
      require: [chatVendorFor(modelId)],
    });

    return this.while('an agent report', async () => {
      const { report, evidence, redactor } = await analyseThread({
        dir: this.dir,
        paths: project.paths,
        config: project.config,
        model: project.model,
        keys,
        threadId: target.header.id,
        modelId,
        source: ask.source,
        ...(effort ? { effort } : {}),
        ...(ask.note.trim() ? { wanted: ask.note } : {}),
        ...(this.deps.appVersion ? { appVersion: this.deps.appVersion } : {}),
        ...(this.deps.userData ? { userData: this.deps.userData } : {}),
      });

      this.redaction = redactor;
      const body = renderReport(report, evidence);
      return { report, title: reportTitle(report), body, ...(await this.keepReport(body)) };
    });
  }

  /**
   * Archive the report, and shrug if that fails. The author has the analysis on screen either way;
   * refusing to show it because a copy could not be written would be losing the thing they paid a
   * minute and a model call for over the thing they did not ask for.
   */
  private async keepReport(body: string): Promise<{ file?: string }> {
    const userData = this.deps.userData;
    if (!userData) return {};
    try {
      return { file: await saveReport(userData, body, new Date()) };
    } catch {
      return {};
    }
  }

  /**
   * The redactor to scan a report with: the one that wrote it, else one built from the project as
   * it stands. The second case is the scripted one — `report.openIssue(body='…')` with no analysis
   * in this process — and building it there costs a project load, which is why the first case is
   * cached rather than rebuilt per keystroke.
   */
  private async reportRedaction(): Promise<Redactor> {
    if (!this.redaction) {
      const project = await loadProject(this.dir);
      this.redaction = makeRedactor(this.dir, project.model);
    }
    return this.redaction;
  }

  /**
   * What `report.openIssue` would do. The leak scan is the refusal: a name the redactor knows,
   * still in the body, is a name about to be typed into a public issue tracker, and it is named
   * back so the author can find it rather than hunt for it.
   */
  async previewIssue(input: { title: string; body: string }): Promise<PromptResult> {
    if (!input.body.trim()) return { ok: false, message: 'There is no report to file.' };
    if (!input.title.trim()) return { ok: false, message: 'An issue needs a title.' };

    const leaked = (await this.reportRedaction()).leaks(input.body);
    if (leaked.length > 0) return { ok: false, message: leakSentence(leaked) };

    const { truncated } = fitBody(input.body);
    const cut = truncated
      ? ' It is too long for a URL, so the issue gets the findings and your clipboard gets all of it.'
      : '';
    return {
      ok: true,
      message: `Opens a new issue in your browser. Nothing is posted until you press Create.${cut}`,
    };
  }

  /**
   * Put the whole report on the clipboard, then open GitHub's new-issue form on as much of it as a
   * URL will hold. The clipboard write comes first deliberately: the browser is where the author
   * loses the report if the URL had to be trimmed, and it has to already be in hand by then.
   *
   * The leak scan runs again here. A check is advice a caller may skip — CDP can, the palette
   * cannot be relied on not to — and the one thing this must never do is publish a name.
   */
  async openIssue(input: { title: string; body: string }): Promise<IssueOpened> {
    const preview = await this.previewIssue(input);
    if (!preview.ok) throw new Error(preview.message);

    const open = this.deps.openExternal;
    if (!open) throw new Error('This build cannot open a browser.');

    const { body, truncated } = fitBody(input.body);
    const url = issueUrl({ title: input.title, body });
    // Belt to `issueUrl`'s own brace: what reaches the shell is checked, not merely composed.
    assertIssueUrl(url);

    this.deps.writeClipboard?.(input.body);
    await open(url.href);
    return { url: url.href, truncated };
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
  ): Promise<{
    character: boolean;
    candidate: boolean;
    approved: boolean;
    candidates: number;
    suspended?: string;
  }> {
    const project = await loadProject(this.dir);
    const character = project.model.characters.get(characterId);
    const candidates = project.store
      .manifest()
      .filter((a) => a.kind === 'portrait' && bindsTo(a, { characterId }));
    const suspended = await this.suspensionFor(project, hash);
    return {
      character: Boolean(character),
      candidate: candidates.some((a) => a.hash === hash),
      approved: character ? isApproved(character) : false,
      candidates: candidates.length,
      ...(suspended ? { suspended } : {}),
    };
  }

  /** Flip a character to approved with `hash`: copy the visible portrait, accept the asset. */
  async approveCharacter(characterId: string, hash: string): Promise<ApproveResult> {
    const project = await loadProject(this.dir);
    if (!project.store.has(hash)) return { ok: false, message: `No asset "${hash}" in the store.` };
    // Approving a suspended picture would bless bytes drawn against a reference that has moved,
    // and everything downstream would inherit it. Repin or regenerate first.
    const suspended = await this.suspensionFor(project, hash);
    if (suspended) return { ok: false, message: `${hash.slice(0, 8)} is suspended: ${suspended}.` };
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
   * Every suspended asset, upstream first, with the sentence for each. Derived on every call —
   * suspension is a walk over the manifest and the rungs, never a stored flag (§13).
   */
  async suspensions(): Promise<Suspension[]> {
    const project = await loadProject(this.dir);
    const shots = await readAllShots(project);
    return [...suspensionsOf(project, shots).values()];
  }

  /** Why one asset is suspended, against a project already loaded. `undefined` when it is not. */
  private async suspensionFor(project: LoadedProject, hash: string): Promise<string | undefined> {
    return suspensionsOf(project, await readAllShots(project)).get(hash)?.reason;
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
    const suspended = suspensionsOf(project, shots).get(hash);
    const task = project.graph.get(asset.sourceTask);
    const ctx = { model: project.model, config: project.config, shots, ...(task ? { task } : {}) };
    const derived = derivePrompt(asset, ctx);
    const view = await this.promptViewOf(project, hash);
    const labels = labelContext(project.model, project.graph);
    const label = labelAssets(manifest, labels).get(hash) ?? hash;
    const prereqs = assetPrereqs(asset, { ...labels, assets: manifest, shots });
    // Only for the kinds that can be accepted at all: a portrait, a concept and an upload are each
    // refused by name before this could be reached, and a second sentence beside those reads as a
    // second rule. Their prereqs are still listed — what a sketch was drawn from is worth showing
    // even where there is nothing to approve.
    const unapproved = ACCEPTABLE.has(asset.kind) ? prereqRefusal(label, prereqs) : undefined;
    const from = slotOf(asset, labels.angleOf?.(asset.sourceTask));
    // A slot only counts while these are the bytes in it: a superseded render keeps its binding,
    // and a pane offering to replace *that* would supersede a picture already moved past.
    const slot = from && task?.status === 'done' && task.output === asset.hash ? from : undefined;
    return {
      hash: asset.hash,
      ext: asset.ext,
      kind: asset.kind,
      label,
      base: isBaseKind(asset.kind),
      accepted: asset.accepted,
      sourceTask: asset.sourceTask,
      ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }),
      ...(asset.title === undefined ? {} : { title: asset.title }),
      ...(derived === undefined ? {} : { derived }),
      // An unknown derivation is not evidence of drift — it means the project no longer describes
      // this asset, which the editor says a different way.
      stale: derived !== undefined && asset.prompt !== undefined && derived !== asset.prompt,
      ...(suspended ? { suspended: suspended.reason } : {}),
      ...(slot ? { slot: slotKey(slot) } : {}),
      prereqs,
      ...(unapproved ? { unapproved } : {}),
      rungs: rungsFor(asset, { model: project.model, shots }),
      ...(project.config.image_params.seed === undefined
        ? {}
        : { configSeed: project.config.image_params.seed }),
      ...(view ? { promptView: view } : {}),
    };
  }

  /**
   * Whether accepting this asset is a question worth answering. Three kinds are refused by name:
   * a portrait, because approving one also writes `character.md` and `approved.png` and that is
   * `gate.approve`; a concept, because nothing downstream consumes one, so `accepted` would
   * mean nothing; and a reference, because nothing generated it — it counts by being pointed at.
   * Already accepted is not a refusal — re-accepting is how an author changes their mind.
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
    if (info.kind === 'reference') {
      return {
        ok: false,
        message: `${info.label} is an upload; nothing generated it, so there is no work to bless. It counts by being pointed at with prompt.addRef.`,
      };
    }
    if (info.suspended) {
      // Accepting is the whole point of suspension: it says these bytes are the answer, and they
      // were drawn against a reference that has since moved.
      return {
        ok: false,
        message: `${info.label} is suspended: ${info.suspended}. Repin or regenerate it first.`,
      };
    }
    // After suspension deliberately: that is a claim about *these* bytes resting on a reference
    // that moved, which is the more specific thing to say. This one is about other bytes.
    if (info.unapproved) return { ok: false, message: info.unapproved };
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
    // Same shape as the concept refusal, for the same reason: an upload's `sourceTask` is a hash of
    // the request that brought the bytes in, and no node ever answered to it.
    if (info.kind === 'reference') {
      return {
        ok: false,
        reason: `${info.label} is an upload: nothing generated it, so there is no task to re-run. Bring in a different image with asset.upload(file=…).`,
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
    const { config, paths } = await loadProject(this.dir);
    const decided = await artNotesOf({ config, paths }, { target, notes });
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Write one art-notes rung, through the rule `vnauthor`'s `set_art_notes` runs — an entity rung
   * into the sheet the model was built from, a shot rung into `work/shots/<sceneId>.json`.
   */
  async setArtNotes(
    target: string,
    notes: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const { config, paths } = await loadProject(this.dir);
    const deps = { config, paths };
    const decided = await artNotesOf(deps, { target, notes });
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const plan = await writeArtNotes(deps, { target, notes });
    return { ok: true, message: plan.note, written: [relPath(this.dir, plan.file)] };
  }

  /** What `art.setSeed` would do, without writing it. */
  async previewArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string }> {
    const { config, paths } = await loadProject(this.dir);
    const decided = await artSeedOf({ config, paths }, { target, seed });
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
  }

  /** Write one rung's image seed, into the same two files `setArtNotes` writes. */
  async setArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const { config, paths } = await loadProject(this.dir);
    const deps = { config, paths };
    const decided = await artSeedOf(deps, { target, seed });
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const plan = await writeArtSeed(deps, { target, seed });
    return { ok: true, message: plan.note, written: [relPath(this.dir, plan.file)] };
  }

  /**
   * The composed prompt for one asset: the chunks the builders derived, what the author's override
   * does to them, and the one string that would be sent. `null` when the manifest has never heard
   * of the hash.
   *
   * The pane reads this off `assetInfo`, so a picture and its prompt are one round trip; the
   * command is the same projection for an agent and for CDP.
   */
  async promptView(hash: string): Promise<PromptView | null> {
    return this.promptViewOf(await loadProject(this.dir), hash);
  }

  /**
   * The reference strip for each chunk: the pin, what it is called, the slot it follows and whether
   * that slot has moved. One label pass and one manifest read, shared by every chunk on the card.
   */
  private chunkRefs(
    project: LoadedProject,
    override: PromptOverride | undefined,
  ): (chunk: string) => ChunkRefInfo[] {
    if (!override?.refs) return () => [];
    const manifest = project.store.manifest();
    const labels = labelContext(project.model, project.graph);
    const names = labelAssets(manifest, labels);
    const ctx = { ...labels, assets: manifest };
    return (chunk) =>
      (override.refs?.[chunk] ?? []).map((ref) => ({
        pin: ref.pin,
        ext: ref.ext,
        label: names.get(ref.pin) ?? ref.pin.slice(0, 8),
        ...(ref.from ? { from: slotKey(ref.from) } : {}),
        ...(refDrift(ref, ctx) ? { drift: true } : {}),
      }));
  }

  /** {@link promptView} against a project already loaded — what `assetInfo` folds in. */
  private async promptViewOf(project: LoadedProject, hash: string): Promise<PromptView | null> {
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return null;
    const shots = await readAllShots(project);
    const task = project.graph.get(asset.sourceTask);
    const ctx = { model: project.model, config: project.config, shots, ...(task ? { task } : {}) };
    const chunks = deriveChunks(asset, ctx);
    if (!chunks) {
      // Nothing to compose: a concept, whose prompt was typed rather than derived, or an asset the
      // project has stopped describing. Either way the recorded prompt is all there is to show — a
      // concept as the one `request` chunk it was asked for, so the pane draws one kind of card.
      const text = asset.prompt ?? '';
      return {
        hash,
        mode: 'custom',
        text,
        chunks:
          asset.kind === 'concept'
            ? [
                {
                  key: 'request',
                  category: 'request',
                  origin: { kind: 'request' },
                  text,
                  derived: text,
                  muted: false,
                },
              ]
            : [],
        held: false,
        missing: [],
        frozen: frozenReason(asset.kind),
      };
    }

    const rung = rungOf(asset);
    const override = rung ? overrideAt(rung, { model: project.model, shots }) : undefined;
    const composed = composePrompt(chunks, override);
    // Only a whole-prompt rewrite can lose a clause; in chunks mode the text *is* the chunks, and
    // marking them would say "not found" about words that are demonstrably there.
    const marks =
      composed.mode === 'chunks'
        ? undefined
        : new Map(
            coverage(enabledChunks(composed.chunks), composed.text).map((c) => [c.key, c.found]),
          );
    const refsOf = this.chunkRefs(project, override);
    return {
      hash,
      mode: composed.mode,
      text: composed.text,
      chunks: composed.chunks.map((c) => ({
        key: c.key,
        category: c.category,
        origin: c.origin,
        ...(c.also ? { also: c.also } : {}),
        text: c.text,
        derived: c.derived,
        ...(c.edit ? { edit: c.edit } : {}),
        ...(c.authored === undefined ? {} : { authored: c.authored }),
        muted: c.muted,
        ...(c.editStale === undefined ? {} : { editStale: c.editStale }),
        ...(marks?.has(c.key) ? { represented: marks.get(c.key)! } : {}),
        ...(refsOf(c.key).length ? { refs: refsOf(c.key) } : {}),
      })),
      held: composed.held,
      missing: marks ? [...marks].filter(([, found]) => !found).map(([key]) => key) : [],
      ...(override?.custom ? { custom: override.custom } : {}),
      ...(override?.agent
        ? {
            agent: {
              ...(override.agent.modelId ? { modelId: override.agent.modelId } : {}),
              ...(override.agent.at ? { at: override.agent.at } : {}),
            },
          }
        : {}),
    };
  }

  /** What one prompt edit would do, without writing it — every `prompt.*` command's `check`. */
  private async previewPrompt(hash: string, edit: PromptEdit): Promise<PromptResult> {
    const project = await loadProject(this.dir);
    const decided = await this.promptPlan(project, hash, edit);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /** Write one prompt edit at the rung that owns the picture. */
  private async writePrompt(hash: string, edit: PromptEdit): Promise<PromptWriteResult> {
    const project = await loadProject(this.dir);
    const decided = await this.promptPlan(project, hash, edit);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    await decided.write();
    return { ok: true, message: decided.note, written: [relPath(this.dir, decided.file)] };
  }

  previewPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'chunk', chunk, how: op, text });
  }

  setPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'chunk', chunk, how: op, text });
  }

  previewMoveChunk(hash: string, chunk: string, after: string): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'move', chunk, after });
  }

  movePromptChunk(hash: string, chunk: string, after: string): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'move', chunk, after });
  }

  previewCustomPrompt(hash: string, text: string): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'custom', text });
  }

  setCustomPrompt(hash: string, text: string): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'custom', text });
  }

  previewClearPrompt(hash: string, part: ClearPart): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'clear', part });
  }

  clearPrompt(hash: string, part: ClearPart): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'clear', part });
  }

  /**
   * The `ChunkRef` an address would attach, and the cycle it would close if it closed one (§14).
   *
   * Enforcement is here, at write time, rather than in the planner: refusing at plan time would mean
   * the project is already broken on disk and the author meets a run failure instead of a rejected
   * gesture. A bare hash attaches with no `from` — an upload or a concept *is* its own identity, so
   * there is no slot under it and it can never drift.
   */
  private async addRefPlan(
    hash: string,
    chunk: string,
    ref: string,
  ): Promise<
    { ok: false; reason: string } | { ok: true; project: LoadedProject; edit: PromptEdit }
  > {
    const project = await loadProject(this.dir);
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return { ok: false, reason: `No asset "${hash}" in the manifest.` };

    const binding = parseSlot(ref);
    if (!binding) {
      return {
        ok: false,
        reason: `"${ref}" names no reference. Give an asset hash, or a slot: portrait:<character>, sheet:<character>/<outfit>/<angle>, plate:<location>/<variant>, shot:<scene>/<shot>.`,
      };
    }
    const labels = labelContext(project.model, project.graph);
    const pin = resolveBinding(binding, { ...labels, assets: project.store.manifest() });
    if (!pin) {
      return {
        ok: false,
        reason: `Nothing fills ${slotLabel(binding)} today, so there is no image to attach.`,
      };
    }
    const target = project.store.manifest().find((a) => a.hash === pin);
    if (!target) {
      return {
        ok: false,
        reason: `${slotLabel(binding)} names ${pin.slice(0, 8)}, which is not in the manifest.`,
      };
    }

    const shots = await readAllShots(project);
    const from = slotOf(asset, labels.angleOf?.(asset.sourceTask));
    if (from) {
      const path = refCycle(from, binding, { model: project.model, shots });
      if (path) return { ok: false, reason: `Cannot attach: ${cycleRefusal(path)}.` };
    }
    return {
      ok: true,
      project,
      edit: {
        op: 'addRef',
        chunk,
        ref: { pin, ext: target.ext, ...(binding.kind === 'asset' ? {} : { from: binding }) },
      },
    };
  }

  /** What `prompt.addRef` would attach, and every reason it would not. */
  async previewAddRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    const plan = await this.addRefPlan(hash, chunk, ref);
    if (!plan.ok) return { ok: false, message: plan.reason };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /** Attach a reference image to one chunk. It re-keys the task, so the picture re-renders. */
  async addPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    const plan = await this.addRefPlan(hash, chunk, ref);
    if (!plan.ok) return { ok: false, message: plan.reason, written: [] };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    await decided.write();
    return { ok: true, message: decided.note, written: [relPath(this.dir, decided.file)] };
  }

  previewDropRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'dropRef', chunk, ref });
  }

  dropPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'dropRef', chunk, ref });
  }

  /**
   * What a repin would move, decided against one load: the slot the reference names, the hash that
   * slot holds today, and — when the author is re-approving — the `done` record that keeps the
   * existing bytes (§13). Both the check and the write ask this, so they cannot disagree.
   *
   * The adopted task's inputs are the previous node's with the old pin swapped for the new one in
   * place. That is exact rather than a re-derivation: a repin touches only the authored tail of
   * `refs`, so the result is provably what the planner will compute. If the derived half moved too,
   * the adopted node is simply an orphan and the picture re-renders — the fail-safe direction.
   */
  private async repinPlan(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<
    | { ok: false; reason: string }
    | {
        ok: true;
        project: LoadedProject;
        edit: PromptEdit;
        note: string;
        adoption?: () => Promise<void>;
      }
  > {
    const project = await loadProject(this.dir);
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    const found = await this.promptChunksOf(project, hash);
    if (!found.ok) return found;

    const pinned = found.override?.refs?.[chunk]?.find(
      (r) => r.pin === ref || r.pin.startsWith(ref),
    );
    if (!pinned) {
      return { ok: false, reason: `No reference "${ref}" on "${chunk}" of ${hash.slice(0, 8)}.` };
    }
    if (!pinned.from) {
      return {
        ok: false,
        reason: `${pinned.pin.slice(0, 8)} is an unlinked reference — it names no slot, so there is nothing to repin it to.`,
      };
    }
    const to = resolveBinding(pinned.from, {
      ...labelContext(project.model, project.graph),
      assets: project.store.manifest(),
    });
    if (!to) {
      return {
        ok: false,
        reason: `Nothing fills that slot today, so there is no hash to repin ${pinned.pin.slice(0, 8)} to.`,
      };
    }
    const target = project.store.manifest().find((a) => a.hash === to);
    if (!target)
      return {
        ok: false,
        reason: `The slot names ${to.slice(0, 8)}, which is not in the manifest.`,
      };
    const edit: PromptEdit = { op: 'repin', chunk, ref: pinned.pin, to, ext: target.ext };

    if (regenerate) {
      return {
        ok: true,
        project,
        edit,
        note: `Repin to ${to.slice(0, 8)} and re-render — the task is newly keyed, so the next run draws it again.`,
      };
    }

    const node = project.graph.get(asset.sourceTask);
    if (!node || !('refs' in node.inputs)) {
      return {
        ok: false,
        reason: `${hash.slice(0, 8)} has no task on record to re-approve against, so it can only be repinned with regenerate=true.`,
      };
    }
    const inputs = {
      ...node.inputs,
      refs: node.inputs.refs.map((r) =>
        r.hash === pinned.pin ? { hash: to, ext: target.ext } : r,
      ),
    } as TaskInputs[TaskKind];
    const req = { kind: node.kind, inputs, output: asset };
    const ctx = {
      has: (h: string) => project.store.has(h),
      node: (h: string) => project.graph.get(h),
    };
    const decided = adoptionOf(req, ctx);
    if (!decided.ok) return { ok: false, reason: decided.reason };
    return {
      ok: true,
      project,
      edit,
      note: `Repin to ${to.slice(0, 8)} and keep these bytes — the newly-keyed task is recorded done with ${hash.slice(0, 8)}, so nothing re-renders.`,
      adoption: async () => {
        const done = await adopt(project.paths, req, ctx);
        if (!done.ok) throw new Error(done.reason);
      },
    };
  }

  async previewRepin(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<PromptResult> {
    const plan = await this.repinPlan(hash, chunk, ref, regenerate);
    if (!plan.ok) return { ok: false, message: plan.reason };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    return decided.ok ? { ok: true, message: plan.note } : { ok: false, message: decided.reason };
  }

  /**
   * Move a pinned reference to what its slot holds now. Written before the adoption is logged, and
   * the adoption is decided *before* either — so a refusal leaves the pin where it was rather than
   * a moved pin with no output.
   */
  async repinPrompt(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<PromptWriteResult> {
    const plan = await this.repinPlan(hash, chunk, ref, regenerate);
    if (!plan.ok) return { ok: false, message: plan.reason, written: [] };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    await decided.write();
    if (plan.adoption) await plan.adoption();
    return { ok: true, message: plan.note, written: [relPath(this.dir, decided.file)] };
  }

  /**
   * What `prompt.condense` would spend the call on. It cannot know what the model will write, so
   * this answers the two questions that do not need it: is there anything to condense, and is
   * there a hand-written prompt in the way.
   */
  async previewCondense(hash: string, force: boolean): Promise<PromptResult> {
    const view = await this.promptView(hash);
    if (!view) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    if (view.frozen) return { ok: false, message: view.frozen };
    if (view.mode === 'custom' && !force) {
      return {
        ok: false,
        message:
          `A custom prompt is already written. prompt.condense(hash='${hash.slice(0, 8)}' ` +
          'force=true) reconciles it against the chunks instead of discarding it.',
      };
    }
    const n = view.chunks.filter((c) => !c.muted).length;
    return { ok: true, message: `Condense ${n} clause${n === 1 ? '' : 's'} into one prompt.` };
  }

  /**
   * Condense the chunks into one prompt and store it at the rung. The condensation is **held** the
   * moment the chunks move under it — `composePrompt` keeps sending this text rather than the
   * fresh chunks, because re-rendering would move the task hash and re-render the picture.
   */
  async condenseAssetPrompt(hash: string, force: boolean): Promise<PromptWriteResult> {
    const allowed = await this.previewCondense(hash, force);
    if (!allowed.ok) return { ok: false, message: allowed.message, written: [] };
    const project = await loadProject(this.dir);
    const decided = await this.promptChunksOf(project, hash);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { chunks, override } = decided;
    const given = enabledChunks(effectiveChunks(chunks, override));

    const result = await this.while('condensing a prompt', async () => {
      const text = await this.condensingText(project, renderPrompt(given));
      return condensePrompt(given, text, force ? override?.custom : undefined);
    });
    if (result.source === 'fallback') {
      return {
        ok: false,
        message: 'No text model answered, so nothing was condensed and nothing was written.',
        written: [],
      };
    }

    const written = await this.writePrompt(hash, {
      op: 'agent',
      text: result.prompt,
      modelId: project.config.models.text,
      at: new Date().toISOString(),
    });
    if (!written.ok) return written;
    const lost = result.coverage.filter((c) => !c.found).map((c) => c.key);
    return {
      ...written,
      message:
        `Condensed ${given.length} clauses into one prompt.` +
        (lost.length ? ` Not found in the result: ${lost.join(', ')}.` : ''),
    };
  }

  /**
   * Which chunks the effective prompt still appears to say — `prompt.check`, and the same answer
   * the pane's marks come from. A read, so it never refuses over mode: in chunks mode nothing can
   * be missing, which is itself worth being able to ask.
   */
  async checkPrompt(hash: string): Promise<PromptResult> {
    const view = await this.promptView(hash);
    if (!view) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    if (!view.missing.length) {
      return { ok: true, message: `Every clause is represented in the ${view.mode} prompt.` };
    }
    return {
      ok: true,
      message: `Not found in the ${view.mode} prompt: ${view.missing.join(', ')}.`,
    };
  }

  /** `project.yaml` as the app reads it, for the Project editor. */
  async projectView(): Promise<ProjectView> {
    const project = await loadProject(this.dir);
    const { config } = project;
    return {
      root: this.dir,
      title: config.title,
      artStyle: config.art_style,
      start: config.start ?? '',
      models: { ...config.models },
      imageParams: { ...config.image_params },
      imageTasks: project.graph.all().filter((task) => IMAGE_KINDS.has(task.kind)).length,
    };
  }

  /** What `project.setArtStyle` would do, without writing it. */
  async previewArtStyle(style: string): Promise<PromptResult> {
    const project = await loadProject(this.dir);
    if (project.config.art_style === style) {
      return { ok: false, message: 'The project already says that.' };
    }
    const count = project.graph.all().filter((task) => IMAGE_KINDS.has(task.kind)).length;
    const said = style.trim() ? `Set the art style to "${style.trim()}".` : 'Clear the art style.';
    return {
      ok: true,
      message: `${said} It opens every image prompt, so it re-keys ${count} image task(s).`,
    };
  }

  /**
   * Write the project's art style. It is spliced into `project.yaml` rather than re-serialized,
   * so an author's comments and key order survive — the same posture the prose writers take with
   * front-matter.
   */
  async setProjectArtStyle(style: string): Promise<PromptWriteResult> {
    const preview = await this.previewArtStyle(style);
    if (!preview.ok) return { ...preview, written: [] };
    if (!(await setArtStyle(this.dir, style))) {
      return { ok: false, message: 'The project already says that.', written: [] };
    }
    return {
      ok: true,
      message: preview.message,
      written: [relPath(this.dir, join(this.dir, CONFIG_FILENAME))],
    };
  }

  /**
   * Where a vendor's key file sits, whether one is already there, and whether an environment
   * variable would shadow it — `resolveKeys` reads `$NAME` first, so a file written under a set
   * variable is a key that never gets used. Reads no key back, here or anywhere.
   */
  private async keyFile(
    vendor: keyof ResolvedKeys,
  ): Promise<{ rel: string; had: boolean; shadow: string }> {
    const rel = `keys/${secretFileFor(vendor)}`;
    const envName = (await loadConfig(this.dir)).keys[vendor];
    const set = (process.env[envName] ?? '').trim() !== '';
    return {
      rel,
      had: await exists(join(this.dir, rel)),
      shadow: set ? ` $${envName} is set and is read first, so the file goes unused.` : '',
    };
  }

  /** What `project.setKey` would do, without writing it. */
  async previewKey(vendor: keyof ResolvedKeys): Promise<PromptResult> {
    const { rel, had, shadow } = await this.keyFile(vendor);
    return {
      ok: true,
      message: `${had ? 'Replace' : 'Write'} the ${vendor} key in ${rel}.${shadow}`,
    };
  }

  /**
   * Store an API key. The value reaches exactly one file — the first name `resolveKeys` looks
   * for — and nothing else: not the message, not the log, and not `commands.jsonl`, where
   * `prop.secret` has already replaced it. `keys` is ignored *before* the write, because
   * commit-on-save runs `git commit -A` and would otherwise commit the file within the second.
   */
  async setKey(vendor: keyof ResolvedKeys, key: string): Promise<PromptWriteResult> {
    const value = key.trim();
    if (!value) return { ok: false, message: 'No key given.', written: [] };

    const { rel, had, shadow } = await this.keyFile(vendor);
    const ignored = await ensureIgnored(this.dir, ['keys']);
    const path = join(this.dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${value}\n`);

    // The key file itself is never reported as written: it is ignored, so nothing downstream
    // may treat it as a document. The `.gitignore` is, because it is committed.
    return {
      ok: true,
      message: `${had ? 'Replaced' : 'Wrote'} the ${vendor} key in ${rel}, which git ignores.${shadow}`,
      written: ignored ? ['.gitignore'] : [],
    };
  }

  /**
   * The text provider a condensation runs against. Under `--mock` the backend echoes the prompt,
   * which no schema accepts, so every condensation would take the deterministic fallback and the
   * real path would never run; the canned answer is the identity condensation, which exercises it
   * with the chunks' own words.
   */
  private condensingText(project: LoadedProject, flat: string): Promise<TextLLM> {
    if (!this.mock) return buildProviders(project, false).then((p) => p.text);
    return Promise.resolve(
      createMockProviders({ textResponses: [JSON.stringify({ prompt: flat, omitted: [] })] }).text,
    );
  }

  /** The derivation an override sits on: the chunks, the rung, and what is stored there today. */
  private async promptChunksOf(
    project: LoadedProject,
    hash: string,
  ): Promise<
    | { ok: false; reason: string }
    | {
        ok: true;
        rung: PromptRung;
        chunks: PromptChunk[];
        override: PromptOverride | undefined;
      }
  > {
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    const shots = await readAllShots(project);
    const task = project.graph.get(asset.sourceTask);
    const ctx = { model: project.model, config: project.config, shots, ...(task ? { task } : {}) };
    const chunks = deriveChunks(asset, ctx);
    const rung = rungOf(asset);
    if (!chunks || !rung) return { ok: false, reason: frozenReason(asset.kind) };
    return { ok: true, rung, chunks, override: overrideAt(rung, { model: project.model, shots }) };
  }

  /**
   * The rule behind every `prompt.*` write, decided once against a fresh load: which rung owns
   * this picture, what the edit does to what is stored there, and which file that lands in.
   *
   * The two writers are the same two `artNotesPlan` has — an entity sheet through `@vn/model`'s
   * `apply*Edit`, or `work/shots/<sceneId>.json` — because an override lives beside the art notes
   * it overrides, and this is the only place in the app that split appears.
   */
  private async promptPlan(
    project: LoadedProject,
    hash: string,
    edit: PromptEdit,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; note: string; file: string; write: () => Promise<void> }
  > {
    const found = await this.promptChunksOf(project, hash);
    if (!found.ok) return found;
    const { rung, chunks, override } = found;
    const next = applyPromptEdit(chunks, override, edit);
    if (!next.ok) return next;

    if (rung.kind === 'shot') {
      const scene = project.model.scenes.get(rung.sceneId);
      if (!scene) return { ok: false, reason: `No scene "${rung.sceneId}" to write to.` };
      return {
        ok: true,
        note: next.note,
        file: project.paths.shotsFile(rung.sceneId),
        write: async () => {
          const loaded = await readShots(
            project.paths,
            scene.id,
            new Set(scene.lines.map((l) => l.id)),
          );
          if (!loaded) throw new Error(`Scene "${scene.id}" has no storyboard to write to.`);
          await writeShots(
            project.paths,
            scene.id,
            loaded.shots.map((s) =>
              s.id === rung.shotId ? withPromptOverride(s, next.override) : s,
            ),
          );
        },
      };
    }

    const location = rung.kind === 'variant';
    const kind = location ? 'location' : 'character';
    const id = rung.kind === 'variant' ? rung.locationId : rung.characterId;
    const docs = location ? project.inputs.locationDocs : project.inputs.characterDocs;
    const doc = entityDoc(docs, id);
    if (!doc) return { ok: false, reason: `No sheet on disk for ${kind} "${id}".` };
    return {
      ok: true,
      note: next.note,
      file: doc.file,
      write: async () => {
        const edited =
          rung.kind === 'variant'
            ? applyLocationEdit(doc.doc, locationOverrideEdit(project, rung, next.override))
            : applyCharacterEdit(doc.doc, characterOverrideEdit(project, rung, next.override));
        if (!edited.ok) throw new Error(`Edit rejected: ${edited.diagnostic.message}`);
        await writeFileAtomic(doc.file, docToMarkdown(edited.value.doc));
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

  /**
   * The rule behind both upload halves: read the bytes once, then let `uploadOf` say everything
   * that can be refused. A relative path is resolved against the project, so a command reads the
   * same file the file picker named.
   */
  private async uploadPlan(
    file: string,
    title: string,
    slot: string,
    replace: boolean,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; project: LoadedProject; path: string; note: string; slot?: RefBinding }
  > {
    const said = file.trim();
    if (!said) return { ok: false, reason: 'Nothing to upload: no file was named.' };
    const path = isAbsolute(said) ? said : join(this.dir, said);
    const project = await loadProject(this.dir);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      return { ok: false, reason: `Cannot read ${relPath(this.dir, path)}.` };
    }
    const decided = uploadOf(project.store, { file: path, title, bytes });
    if (!decided.ok) return { ok: false, reason: decided.reason };
    if (!slot.trim()) return { ok: true, project, path, note: decided.plan.note };

    // Both refusals before either write: an upload that names a slot is one act, and hearing
    // "that slot is already rendered" after the bytes are copied is hearing it too late.
    const hash = sha256(bytes);
    const adoption = await this.adoptPlan(hash, slot, replace, bytes);
    if (!adoption.ok) return { ok: false, reason: adoption.reason };
    const supersede = adoption.plan.supersedes
      ? ` It supersedes the render ${adoption.plan.supersedes.slice(0, 8)}, whose bytes stay in the store.`
      : ' The next run adopts it instead of rendering one.';
    return {
      ok: true,
      project,
      path,
      slot: adoption.slot,
      note: `Would bring ${basename(path)} in as ${hash.slice(0, 8)} and make it the ${adoption.plan.label}.${supersede}`,
    };
  }

  /** What `asset.upload` would bring in, without writing anything. */
  async previewUpload(
    file: string,
    title: string,
    slot = '',
    replace = false,
  ): Promise<{ ok: boolean; message: string }> {
    const decided = await this.uploadPlan(file, title, slot, replace);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Bring an outside image into the base asset store. With no slot it is a `reference`: nothing
   * generated it, so it is never accepted and never planned — it exists only to be pointed at by a
   * prompt chunk. With a slot it is filed the same way and then adopted as that slot's output.
   */
  async uploadAsset(
    file: string,
    title: string,
    slot = '',
    replace = false,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    const decided = await this.uploadPlan(file, title, slot, replace);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { project, path } = decided;
    const result = await uploadReference({ store: project.store }, { file: path, title });
    const already = result.known ? ' It was already in the store; nothing new was written.' : '';
    const uploaded = `Uploaded "${result.title}" as ${result.ref.hash.slice(0, 8)}.${already}`;
    const written = [
      relPath(this.dir, result.stored),
      relPath(this.dir, project.paths.baseManifest),
    ];
    if (!decided.slot) return { ok: true, message: uploaded, hash: result.ref.hash, written };

    // The bytes are in by now, so a refusal here is recoverable rather than lost — which is what
    // the message has to say, because the author's file did land somewhere.
    const adopted = await this.adoptAsset(result.ref.hash, slot, replace);
    if (!adopted.ok) {
      return {
        ok: false,
        message: `${uploaded} It could not be adopted, and stays a reference: ${adopted.message} Finish with asset.adopt(hash='${result.ref.hash}' slot='${slot}').`,
        hash: result.ref.hash,
        written,
      };
    }
    return {
      ok: true,
      message: `${uploaded} ${adopted.message}`,
      hash: result.ref.hash,
      written: [...written, ...adopted.written],
    };
  }

  /**
   * The rule behind both adoption halves: read the slot address, then let `adoptionForSlot` say
   * everything else. `bytes` is for the pre-upload case, where the hash is not in the store yet.
   */
  private async adoptPlan(
    hash: string,
    slot: string,
    replace: boolean,
    bytes?: Uint8Array,
  ): Promise<
    | { ok: false; code: string; reason: string }
    | { ok: true; project: LoadedProject; slot: RefBinding; plan: AdoptSlotPlan }
  > {
    const said = parseSlot(slot);
    if (!said) {
      return {
        ok: false,
        code: 'NOT_A_SLOT',
        reason: `"${slot}" is not a picture in this project. A slot reads like plate:cafe/night, sheet:aiko/gala/front or shot:greet/s2.`,
      };
    }
    const project = await loadProject(this.dir);
    const decided = await adoptionForSlot(
      { config: project.config, paths: project.paths, store: project.store },
      { hash, slot: said, replace, ...(bytes ? { bytes } : {}) },
    );
    return decided.ok
      ? { ok: true, project, slot: said, plan: decided.plan }
      : { ok: false, code: decided.code, reason: decided.reason };
  }

  /** What `asset.adopt` would make this picture, without writing anything. */
  async previewAdopt(
    hash: string,
    slot: string,
    replace: boolean,
  ): Promise<{ ok: boolean; message: string }> {
    const decided = await this.adoptPlan(hash, slot, replace);
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Record bytes already in the store as a slot's output — the general form of promotion. The task
   * identity is derived from the project as it stands and logged `done`, so the next run adopts the
   * picture rather than rendering over it.
   */
  async adoptAsset(
    hash: string,
    slot: string,
    replace: boolean,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    const decided = await this.adoptPlan(hash, slot, replace);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { project, slot: binding } = decided;
    const result = await adoptSlot(
      { config: project.config, paths: project.paths, store: project.store },
      { hash, slot: binding, replace },
    );
    const superseded = result.plan.supersedes
      ? ` It supersedes the render ${result.plan.supersedes.slice(0, 8)}, whose bytes stay in the store.`
      : '';
    return {
      ok: true,
      message: `${hash.slice(0, 8)} is now the ${result.plan.label}.${superseded}`,
      hash: result.ref.hash,
      written: this.adoptWrote(project, binding, result.plan),
    };
  }

  /**
   * The rule behind both replace halves: the asset names its own slot, so an author replacing the
   * picture in front of them never types one. Refusals come from {@link adoptionForSlot} asked
   * about these very bytes — a portrait, a concept and an upload are refused there, by name, and
   * asking twice is how a strip on screen and the act it runs stay the same rule.
   */
  private async replacePlan(
    hash: string,
  ): Promise<{ ok: false; reason: string } | { ok: true; slot: RefBinding; note: string }> {
    const info = await this.assetInfo(hash);
    if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    if (!info.slot) {
      return {
        ok: false,
        reason: `${info.label} fills no slot — nothing planned it, or a later render took the slot over, so there is nothing for a file to replace.`,
      };
    }
    const slot = parseSlot(info.slot);
    if (!slot) return { ok: false, reason: `"${info.slot}" is not a picture in this project.` };

    // Every refusal but one. `MOCK_PLACEHOLDER` judges the bytes coming *in*, and the chooser has
    // not produced any yet — `uploadOf` refuses mock art at the upload, which is where that belongs.
    // Asking about the outgoing picture is only how the slot itself gets checked.
    const decided = await this.adoptPlan(hash, info.slot, false);
    if (!decided.ok && decided.code !== 'MOCK_PLACEHOLDER') {
      return { ok: false, reason: decided.reason };
    }
    const label = decided.ok ? decided.plan.label : slotLabel(slot);
    return {
      ok: true,
      slot,
      note: `Opens a file chooser; what you choose becomes the ${label}, superseding ${hash.slice(0, 8)} — whose bytes stay in the store.`,
    };
  }

  /** What `asset.replace` would replace, before the chooser is opened. */
  async previewReplace(hash: string): Promise<{ ok: boolean; message: string }> {
    const decided = await this.replacePlan(hash);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Put an outside file in the place of a picture the project generated: upload it, then adopt it
   * onto the slot those bytes fill. One act, so a file that lands but cannot be adopted says so —
   * `uploadAsset` is where that sentence lives.
   */
  async replaceAsset(
    hash: string,
    file: string,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    const decided = await this.replacePlan(hash);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    return this.uploadAsset(file, '', slotKey(decided.slot), true);
  }

  /** What an adoption touched: the manifest its kind routes to, the log, and a shot's own file. */
  private adoptWrote(project: LoadedProject, slot: RefBinding, plan: AdoptSlotPlan): string[] {
    const manifest =
      plan.kind === 'shot_image' ? project.paths.manifest : project.paths.baseManifest;
    return [
      ...(slot.kind === 'shot' ? [relPath(this.dir, project.paths.shotsFile(slot.sceneId))] : []),
      relPath(this.dir, manifest),
      relPath(this.dir, project.paths.tasksLog),
    ];
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
    const labels = labelContext(project.model, project.graph);
    return buildDocTree({
      root: this.dir,
      model: project.model,
      inputs: project.inputs,
      manifest,
      shots,
      bible: bible.files(),
      wikiDir: relPath(this.dir, project.paths.wikiDir),
      assetLabels: labelAssets(manifest, labels),
      // Always an array, never undefined: the branch is drawn even with nothing in it, and only a
      // caller outside the app (a test, the CLI) leaves it out.
      skills: await this.skillEntries(),
      // The same walk the Task Graph pane reads, over the same load: the tree's two unapproved
      // groups are projections of it, so nothing here enumerates slots a second time.
      slots: buildSlotGraph({
        ...labels,
        assets: manifest,
        shots,
        config: project.config,
        graph: project.graph,
      }),
    });
  }

  /**
   * The project's skills, as the tree needs them — one `discoverSkills` per doc-tree read. The
   * whole instruction body is dropped here rather than in the renderer: what ships is identity.
   */
  private async skillEntries(): Promise<SkillEntry[]> {
    const skills = await discoverSkills(skillRoots(this.dir));
    return skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      file: relPath(this.dir, skill.file),
      script: skill.script !== undefined,
    }));
  }

  /** The tree's other mode: what is actually on disk, `.git` and `node_modules` excluded. */
  async fileTree(): Promise<DocNode[]> {
    return fileTree(await walkFiles(this.dir));
  }

  /**
   * Every file under `.aiagent/skills`, as the Skills pane's own tree — the *content* the document
   * tree deliberately leaves out.
   *
   * Its own walk rather than a filter over `fileTree()`: that one is capped at 5000 files across
   * the whole project, so on a large one `.aiagent` could be truncated away and this pane would
   * draw an empty directory with nothing to say about why. It would also ship the entire project's
   * file list to paint a dozen rows.
   *
   * No skills directory at all is `[]`, not a failure: that is the state every new project starts
   * in, and it is the Skills branch being drawn empty that tells the author what to do about it.
   */
  async skillTree(): Promise<DocNode[]> {
    const root = join(this.dir, PROJECT_SKILLS_DIR);
    if (!(await exists(root))) return [];
    // The paths come back relative to the skills directory, so the prefix is what makes each id a
    // workspace-relative path `doc.read` would take.
    return fileTree(await walkFiles(root), DEFAULT_CAP, `${relPath(this.dir, root)}/`);
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
   * Where a scaffolded document would land and what it would say. The templates are the same
   * `newCharacterTemplate` / `newLocationDoc` / `newSkillTemplate` the agent's `create_character`
   * and `create_skill` call, so one authorial act has one answer and the id is derived in exactly
   * one place — a reader cannot tell whether a human or the agent made a file by looking at it. The path is conventional; filing a sheet elsewhere is a move, not a different
   * scaffolder.
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
    // A skill is a directory with a `SKILL.md` in it. `writeFileAtomic` makes the directory, so
    // nothing here has to — and the refusal that results is deliberately *not* `writeSkill`'s. That
    // one refuses an existing **directory**; this goes through `checkDocWrite` with an empty
    // `seenHash` and refuses an existing **file**. So a directory a human has already put a vetted
    // `run.mjs` in accepts the author's scaffold and rejects the agent's, which is the right way
    // round: the human is the one who put the script there.
    if (kind === 'skill') {
      const id = skillId(name);
      if (!id) return null;
      return {
        id,
        path: relPath(this.dir, join(this.dir, PROJECT_SKILLS_DIR, id, 'SKILL.md')),
        text: newSkillTemplate(name),
      };
    }
    // A character gets the full template, which is text because its palette note is a YAML
    // comment; a location is still front-matter alone, so it goes through the doc scaffolder.
    if (kind === 'character') {
      const id = slug(name);
      if (!id) return null;
      const path = relPath(this.dir, paths.characterFile(id));
      return { id, path, text: newCharacterTemplate(name) };
    }
    const doc = newLocationDoc(name);
    const id = String(doc.data['id'] ?? '');
    if (!id) return null;
    return { id, path: relPath(this.dir, paths.locationFile(id)), text: docToMarkdown(doc) };
  }

  /** Would the scaffold land? Mostly: is that name already taken. */
  async previewCreate(kind: NewDocKind, name: string): Promise<DocResult<DocWritePlan>> {
    const scaffold = this.newDoc(kind, name);
    if (!scaffold) return { ok: false, reason: `"${name}" does not name a ${kind}` };
    return checkDocWrite(this.dir, scaffold.path, scaffold.text, '', SCENE_WRITER);
  }

  /**
   * Scaffold a character, a location, a wiki note or a skill from a **name**. The empty `seenHash` is what
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

  /**
   * Read a document and work out what renaming it to `name` would write. Where the name lives is
   * `renameInText`'s call; this is the half that touches the disk, so both the check and the run
   * ask the same question of the same bytes.
   */
  private async planRename(
    path: string,
    name: string,
  ): Promise<DocResult<{ text: string; what: string; seenHash: string }>> {
    const read = await this.readDoc(path);
    if (!read.ok) return read;
    const renamed = renameInText(path, read.file.text, name);
    if (!renamed.ok) return { ok: false, reason: renamed.reason };
    return { ok: true, text: renamed.text, what: renamed.what, seenHash: read.file.hash };
  }

  /** What `doc.rename` would do, decided without writing. */
  async previewRename(path: string, name: string): Promise<DocResult<{ note: string }>> {
    const plan = await this.planRename(path, name);
    if (!plan.ok) return plan;
    const write = await this.previewDoc(path, plan.text, plan.seenHash);
    if (!write.ok) return write;
    return { ok: true, note: `Rewrite ${plan.what} in ${path} as "${name.trim()}".` };
  }

  /**
   * Rename one document in place. The **file never moves**: an id is derived from a name once, at
   * creation, and afterwards it is what shots, cast lists and `[[goto:]]` markers point at.
   */
  async renameDoc(
    path: string,
    name: string,
  ): Promise<DocResult<DocSaveResult & { what: string }>> {
    const plan = await this.planRename(path, name);
    if (!plan.ok) return plan;
    const saved = await this.saveDoc(path, plan.text, plan.seenHash);
    if (!saved.ok) return saved;
    return { ...saved, what: plan.what };
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
      heading: headingOf(scene),
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
    const manifest = project.store.manifest();
    const exts = new Map(manifest.map((a) => [a.hash, a.ext]));
    // The same walk `docTree` reads. Emitted in `order`, so the wire carries the topology the
    // pane needs without shipping the two Maps: upstream is always earlier in the array.
    const slots = buildSlotGraph({
      ...labelContext(project.model, project.graph),
      assets: manifest,
      shots: await readAllShots(project),
      config: project.config,
      graph: project.graph,
    });
    return {
      tasks: [...project.graph.all()].map((t) => narrowTask(t, (hash) => exts.get(hash))),
      gatePending: gate.pending,
      blockedOnGate: !gate.cleared,
      slots: slots.order.map((key) => slots.nodes.get(key)!),
    };
  }

  /**
   * What a run would find. The count is a **dry run against mock providers** — what `vngen cost`
   * does — rather than a read of the replayed graph: `tasks.jsonl` holds only what earlier runs
   * planned, so on a project that has never run it says zero while the work is not zero. Nothing
   * is written; a dry run plans with `readOnlyShots` and requeues in memory.
   *
   * The number is still a floor, because planning is incremental and a wave that unlocks later
   * work has not run. So it is reported, never refused — and the keys a real run needs are
   * checked separately, since a dry run needs none.
   */
  async runPreconditions(mock: boolean): Promise<{
    pending: number;
    byKind: Record<string, number>;
    imageCalls: number;
    reviewCalls: number;
    blockedOnGate: boolean;
    gatePending: string[];
    /** Why keys did not resolve — naming the source, never a value. Null when they did. */
    keyError: string | null;
  }> {
    const project = await loadProject(this.dir);
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
    const summary = await runPipeline({
      model: project.model,
      graph: project.graph,
      store: project.store,
      providers: await buildProviders(project, true),
      config: project.config,
      paths: project.paths,
      dryRun: true,
      now: () => new Date().toISOString(),
    });
    return {
      pending: summary.preview.pendingTasks,
      byKind: summary.preview.byKind,
      imageCalls: summary.preview.imageCalls,
      reviewCalls: summary.preview.reviewCalls,
      blockedOnGate: summary.blockedOnGate,
      gatePending: summary.gate.pending,
      keyError,
    };
  }

  /**
   * What `decomposeAllScenes` would do, for free. A `check` may not call the model, so this is the
   * cheap half: how many scenes have no storyboard, which files will not parse, which scenes name
   * a character the project does not have yet — and whether the *text* key resolves.
   *
   * Deliberately `anthropic` and not `gemini`: decomposition draws nothing, and refusing it for a
   * missing image key would be a refusal the author cannot act on.
   */
  async decomposePreconditions(): Promise<{
    pending: string[];
    kept: string[];
    unreadable: string[];
    atRisk: string[];
    /** Why the text key did not resolve — naming the source, never a value. Null when it did. */
    keyError: string | null;
  }> {
    const project = await loadProject(this.dir);
    let keyError: string | null = null;
    try {
      await resolveKeys(project.config, {
        secretsDirs: await secretDirsFor(project.dir),
        require: ['anthropic'],
      });
    } catch (err) {
      keyError = err instanceof Error ? err.message : String(err);
    }
    return { ...(await decomposeAllPreview(project.model, project.paths)), keyError };
  }

  /**
   * Decompose every reachable scene that has no storyboard yet. Real providers always: a mock
   * decomposition is the deterministic baseline, and `decomposeAll` would decline to write it —
   * so running this against mocks would be a no-op that looked like work.
   */
  async decomposeAllScenes(): Promise<DecomposeAllResult> {
    return this.while('decomposing scenes', async () => {
      const project = await loadProject(this.dir);
      return decomposeAll({
        model: project.model,
        providers: await buildProviders(project, false),
        paths: project.paths,
      });
    });
  }

  async runPipeline(mock: boolean): Promise<PipelineRunResult> {
    // The whole method, loads included: `busy()` has to be true from the call, not from the
    // moment the scheduler starts, or a switch could land in the gap.
    const cancel = new AbortController();
    this.cancel = cancel;
    const { summary, assets } = await this.while('a pipeline run', async () => {
      const project = await loadProject(this.dir);
      const providers = await buildProviders(project, mock);
      const ran = await runPipeline({
        model: project.model,
        graph: project.graph,
        store: project.store,
        providers,
        config: project.config,
        paths: project.paths,
        dryRun: mock,
        now: () => new Date().toISOString(),
        signal: cancel.signal,
        onProgress: (p) => {
          this.progress = { ran: p.ran, pending: p.pending };
          this.announceBusy();
        },
      });
      // Read the manifest inside the closure, while the project that ran is still in hand — the
      // labels below name pictures this run produced, and reloading to find them is a second read
      // of everything for a handful of hashes.
      return { summary: ran, assets: project.store.manifest() };
    }).finally(() => {
      if (this.cancel === cancel) this.cancel = undefined;
    });
    this.announceRun(summary, assets, mock);
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
      ...(summary.stopped ? { stopped: true } : {}),
    };
  }

  /**
   * File what the run did: one notification per picture it produced, each linked to the asset
   * editor by the hash it made, and one for the run itself.
   *
   * These all arrive at the end, and deliberately: a notification is a durable record of what
   * happened, so the count that moves while a run is in flight is the `busy` push instead.
   */
  private announceRun(summary: RunSummary, assets: readonly Asset[], mock: boolean): void {
    for (const task of summary.ran) {
      const hash = task.output;
      if (task.status !== 'done' || !hash) continue;
      const asset = assets.find((a) => a.hash === hash);
      const label = asset ? assetSlotLabel(asset) : `${task.kind} ${hash.slice(0, 8)}`;
      void notify({
        category: 'asset',
        source: 'pipeline',
        message: `Rendered ${label}.`,
        link: { editor: 'asset', subject: hash },
      });
    }

    for (const task of summary.failed) {
      void notify({
        category: 'error',
        level: 'error',
        source: 'pipeline',
        message: `${task.kind} ${task.hash.slice(0, 8)} failed: ${task.error ?? 'no reason recorded'}.`,
      });
    }

    const ran = summary.ran.length;
    const how = mock ? 'Dry run' : 'Run';
    const gate = summary.blockedOnGate ? ', halted at the character gate' : '';
    const ended = summary.stopped ? 'stopped' : 'finished';
    void notify({
      category: 'pipeline',
      level: summary.failed.length > 0 ? 'warn' : 'info',
      source: 'pipeline',
      message: `${how} ${ended}: ${ran} task${ran === 1 ? '' : 's'}, ${summary.failed.length} failed${gate}.`,
    });
  }
}
