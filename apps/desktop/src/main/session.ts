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
  KEY_VENDORS,
  keyStatus,
  loadConfig,
  resolveKeys,
  secretDirsFor,
  secretFileFor,
  setArtStyle,
  setStartScene,
  userKeysDir,
  type ProjectConfig,
  type ResolvedKeys,
  type VendorKeyStatus,
} from '@vn/config';
import { chmod, mkdir, readdir, readFile, rename } from 'node:fs/promises';
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
  deleteShots,
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
  type GuardedWriters,
} from '@vn/store';
import {
  activeOutputs,
  bindSlots,
  estimateGraph,
  estimateSentence,
  priceEstimate,
  pricesAreStale,
  registerGenRuntimes,
  writeGraphFile,
  type GenPricedEstimate,
  type Graph as GenGraph,
  type GraphId,
  type GraphJournalRecord,
} from '@vn/gengraph';
import {
  appendGraphJournal,
  executeGenGraph,
  graphBlobStore,
  graphJournalFile,
  invalidateGenGraph,
  readGraphJournal,
  refreshUserPrices,
  type GenRunContext,
} from '@vn/gengraph/state';
import { loadGraph, logTask, type TaskGraph } from '@vn/taskgraph';
import { exists, readText, sha256, writeFileAtomic } from '@vn/util';
import {
  basePromptOf,
  baseRefusal,
  createGenServices,
  decomposeAll,
  decomposeAllPreview,
  driftOf,
  gateStatus,
  hostPriceTables,
  indexGraphs,
  isApproved,
  slotOfTask,
  type DecomposeAllResult,
  type GraphRuntime,
  type LoadedGraph,
} from '@vn/pipeline';
import {
  adopt,
  adoptSlot,
  adoptionForSlot,
  adoptionOf,
  artNotesOf,
  artSeedOf,
  assetApproved,
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
  resolveSlot,
  rungOf,
  rungsFor,
  setArtNotes as writeArtNotes,
  setArtSeed as writeArtSeed,
  slotKey,
  slotLabel,
  slotOf,
  slotTaskHash,
  supersededBy,
  subjectEntity,
  suspensionMap,
  uploadOf,
  uploadReference,
  type AdoptSlotPlan,
  type ConceptRequest,
  type PromptRung,
  type Suspension,
} from '@vn/artgen';
import {
  captureSnapshot,
  chatBackendFor,
  chatVendorFor,
  createImageBackend,
  createMockProviders,
  createProviders,
  StubImageBackend,
  type ChatBackend,
  type ImageBackend,
} from '@vn/providers';
import {
  API_RETRIES,
  Agent,
  COMPACTION_SYSTEM,
  TRIAGE_MODEL,
  NativeAgentBackend,
  StructuredAgentBackend,
  Workspace,
  apiRecoveryQuestion,
  archiveUpload,
  PROJECT_SKILLS_DIR,
  compactRange,
  compactionPrompt,
  composeSystem,
  createRegistry,
  discoverSkills,
  historyTools,
  lastCompleteTurn,
  focusOnScene,
  loadContext,
  newSkillTemplate,
  readApiPlan,
  restorable,
  skillId,
  skillRoots,
  systemSections,
  workspaceArtGen,
  workspaceTextLLM,
  type AgentBackend,
  type AgentEvent,
  type AgentMessage,
  type AgentMode,
  type ApiFailure,
  type Approvable,
  type ApiRecovery,
  type AskQuestion,
  type BackendKind,
  type GeneratedContextState,
  type GeneratedCounts,
  type HistoryReader,
  type Permission,
  type Plan,
  type PlanDecision,
  type RunResult,
  type SectionDelta,
  type SystemSection,
  type ToolContext,
  type UploadBatch,
  type WorkspaceIndex,
} from '@vn/authoring';
import type { Excerpt } from '@vn/bible';
import { runPipeline, type RunSummary } from '@vn/scheduler';
import { buildPlayable, loadSceneShots } from '@vn/export';
import {
  deleteShot as planDeleteShot,
  moveShot,
  newShot as planNewShot,
  setCoverage,
  setSceneOutfit,
  setShotOutfit,
  setShotVariant,
  wardrobesOf,
  type BranchOp,
  type DeleteShotOp,
  type LineOp,
  type NewShotOp,
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
  TEXT_MODELS,
  bindsTo,
  resolveEffort,
  type BudgetChoice,
  type TaskKind,
} from '@vn/types';
import {
  PASTE_BODY,
  assertIssueUrl,
  createAnalyst,
  issueUrl,
  openingMessage,
  renderReport,
  reportTitle,
  sourceRoot,
  type Analyst,
  type AnalystGrant,
  type Redactor,
  type Report,
} from '@vn/agentreport';
import { BUSY_AGENT, BUSY_PASS, BUSY_REPORT, BUSY_RUN, busyName } from '../shared/ipc.js';
import type {
  AgentSystem,
  ApproveResult,
  AssetFailure,
  AssetInfo,
  BranchEditResult,
  DocNode,
  DocSaveResult,
  DocTree,
  GateCandidate,
  GraphDocRead,
  KeyScope,
  KeyStatusView,
  PipelineRunResult,
  PipelineStatus,
  ProjectView,
  ReportRow,
  ReportStateView,
  SceneCoverage,
  SceneEditResult,
  StoryGraph,
} from '../shared/ipc.js';
import { parseKeyGuide, type GuideUrlField, type KeyGuide } from '../shared/apikeys.js';
import { reorderApprovals, type ApprovalQueue } from './approvals.js';
import { graphSlugs, nodeIdOf, readGraph, type GraphSlug } from './graphs.js';
import { readResource } from './resources.js';
import { notify } from './notifications.js';
import {
  CHECK_TIMEOUT_MS,
  RELEASES_API,
  RELEASES_PAGE,
  checkAgainst,
  runningVersion,
  unreachable,
  type UpdateCheck,
} from './updates.js';
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
  compacted,
  decided,
  emptyConvo,
  proposed,
  queried,
  received,
  replayed,
  type CompactionMark,
  type Convo,
  type ThreadUsage,
} from '../shared/convo.js';
import {
  ConflictedLogError,
  NATIVE_VERSION,
  appendCompaction,
  appendItem,
  appendNative,
  appendUsage,
  archiveThread,
  bindThread,
  listThreads,
  liveMessages,
  nativeFile,
  openThread,
  readNative,
  readThread,
  retitleThread,
  threadFile,
  titleFrom,
  type NativeLine,
  type NativeLog,
  type ThreadHeader,
  type ThreadRecord,
} from './threads.js';
import { resumeRefusal, type OpenedThread, type ResumeState } from '../shared/threads.js';
import type { ChunkRefInfo, PromptView } from '../shared/prompt.js';
import { adviseRun, analysisEffort } from '../shared/advice.js';
import {
  NO_SOURCE,
  analyseThread,
  analysisParts,
  detailGrant,
  makeRedactor,
  openTranscript,
  saveReport,
  sourceGrant,
  type AnalysisParts,
  type AnalysisRequest,
  type Transcript,
} from './agentreport.js';

/** A backend that does no LLM work — lets the app run offline (mirrors the REPL's --mock). */
class MockAgentBackend implements AgentBackend {
  readonly kind = 'mock';

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
  /**
   * One event of the analyst's turn. A separate door from {@link emitEvent} because a debug
   * conversation is about the authoring agent rather than part of it, and putting it on the same
   * channel would record it into the very thread being analysed.
   */
  emitReport(event: AgentEvent): void;
  requestPlan(plan: Plan): Promise<PlanDecision>;
  /**
   * The author's answers to a form, one per question and in its order. An empty string is a
   * deliberate answer and is passed through as-is, not treated as a skip. A question's `choices`
   * is a shortlist the card offers to click; the answer comes back as a string either way.
   */
  requestAnswer(questions: readonly AskQuestion[]): Promise<string[]>;
  /** Yes or no to an always-confirm tool. `detail` is the English sentence the card reads out. */
  requestConfirm(tool: string, detail: string): Promise<boolean>;
  /** The app build, so a bug report names the code a maintainer should read. Absent in tests. */
  appVersion?: string;
  /**
   * Where the app may keep files that belong to the app rather than the author — a drafted bug
   * report, cached provider docs. Deliberately not under the project, so neither ends up in the
   * project's git history.
   */
  userData?: string;
  /**
   * Hand a URL to the OS, and put text on the clipboard. Both come from Electron, so they arrive
   * as injected functions rather than imports — this file is typechecked and tested with no app
   * around it. When they are absent there is no browser, and `report.openIssue` reports that
   * rather than claiming success.
   */
  openExternal?(url: string): Promise<void>;
  writeClipboard?(text: string): void;
  /**
   * Tell the window what long-running work is in flight. Not routed through the command host:
   * the effect is pushed while a command is still running, which is when that host has not
   * returned an outcome to attach anything to.
   */
  pushBusy(state: { what?: string; ran: number; pending: number }): void;
  /**
   * Offer to diagnose the call that just failed. Pushed for the same reason `pushBusy` is: the
   * author is answering a card that is still open inside a running turn, and there is no command
   * outcome to hang it on.
   */
  offerDiagnosis?(fault: { thread?: string; message: string }): void;
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
  /** Every discovered sheet and scene chunk, each carrying the file it was found in. Entities are
   * discovered by tag rather than by path, so this record is the only place that knows which
   * file holds which entity. */
  inputs: LoadedInputs;
}

/** The inputs `@vn/scriptedit` decides and writes against, built from one loaded project. */
const editInputOf = (project: LoadedProject): SceneEditInput => ({
  paths: project.paths,
  sources: project.sources,
  ...(project.config.start === undefined ? {} : { entry: project.config.start }),
});

/**
 * The task kinds that render a picture. Each one's prompt opens with the project's art style, so
 * this is exactly the set of tasks a style change re-keys. `vision_review` and `prompt_refine`
 * read a prompt but never carry the style preamble.
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
 * The kinds `previewAccept` does not refuse outright. The excluded kinds have no approval to
 * grant or withhold: a portrait is approved through the character gate, a concept is consumed by
 * nothing, and an upload was never generated in the first place.
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
 * scene's problem. With `reportBroken` it becomes a `null` the tree draws a badge for. Without
 * that option the scene is simply absent, which is what every other reader wants.
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
 * The character edit that applies one rung's prompt override. Clearing an override must be
 * stated explicitly: an empty override object is what `overrideData` serializes as a removed
 * key, so `undefined` here still produces an edit.
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
  /** Whether the analyst may read the requests this session sent. Off unless the box is ticked. */
  detail?: boolean;
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

/** What every `report.*` command that needs a live conversation refuses with when there is none. */
export const NO_REPORT = 'No debug conversation is open.';

/** What `report.say` refuses with while a turn is in flight. `report.stop` is accepted instead. */
export const REPORT_BUSY = 'The analyst is still answering.';

/** Where `report.openIssue` sent the author. */
export interface IssueOpened {
  url: string;
}

/**
 * The refusal message for a report that still contains redacted names. It names only the first
 * leak: the author fixes them one at a time and the scan re-runs on every keystroke, so listing
 * all of them would produce sentences that go stale as soon as the first edit lands.
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
 * Describes where a key came from, in words the pane can show. The four sources need
 * distinguishing because they mean different things: a key in the project is a fact about the
 * project, a key in the user directory is a fact about the machine, and an environment variable
 * is a fact about whatever shell launched the app — the source an author cannot see and the one
 * most likely to be stale.
 *
 * Pure, and it never touches the key value: `VendorKeyStatus` does not carry one.
 */
export function describeKeySource(projectDir: string, status: VendorKeyStatus | undefined): string {
  if (!status?.source) return 'Not set.';
  if (status.source.kind === 'env') return `From $${status.source.name}.`;
  const { dir, file } = status.source;
  if (dir === userKeysDir()) return `From ${join(dir, file)} — every project on this machine.`;
  const within = relative(projectDir, dir);
  if (!within.startsWith('..') && !isAbsolute(within)) {
    return `From ${join(within, file).split(sep).join('/')} in this project.`;
  }
  return `From ${join(dir, file)}.`;
}

/**
 * Directories no file tree of a project should ever show, and the walk's cap. `.vnstudio` holds
 * the layout templates, which are surfaced through the View menu; a serialized JSON mesh is not
 * a document anyone opens in an editor.
 */
const TREE_SKIP = new Set(['.git', 'node_modules', '.vnstudio']);
const TREE_MAX_FILES = 5000;

/** The command namespaces that own the guarded directories, named in a whole-file save's refusal. */
const DOC_WRITERS: GuardedWriters = { scenes: 'story.*', graphs: 'gengraph.*' };

/** The four things `doc.create` scaffolds. A note is a title and nothing else. */
export type NewDocKind = 'character' | 'location' | 'note' | 'skill';

/**
 * What the model will make of a document that has already been saved — a diagnostic sentence, or
 * nothing. Dispatch is by the tag the incoming text carries, falling back to the conventional
 * directory — the same rule entity discovery uses. A file that claims to be neither kind is a
 * note and is not checked.
 */
function entityDiagnostic(path: string, doc: FrontMatterDoc): string | undefined {
  const kind = taggedKind(doc.data) ?? conventionalKind(path);
  if (kind === undefined) return undefined;
  const res = kind === 'character' ? characterFromDoc(doc) : locationFromDoc(doc);
  return res.ok ? undefined : res.diagnostic.message;
}

/** The four directories the project map is derived from — a write to any of them makes it stale. */
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
 * What a resumed conversation is told about the gap it is being continued across. Derived from the
 * header on every resume rather than written into the log, so a thread continued three times
 * carries one note rather than three.
 *
 * The second sentence is the load-bearing one: `edit_file` runs against a ledger of what this
 * conversation has read, and restoring the messages does not restore the ledger.
 */
function resumedNote(header: ThreadHeader): AgentMessage {
  const archived = header.archived?.[header.archived.length - 1];
  const saved = archived ? ` It was last saved into git at ${archived.commit.slice(0, 8)}.` : '';
  return {
    role: 'context',
    content:
      'This conversation was closed and has now been reopened, so the project may have changed ' +
      `since the messages above.${saved} Nothing read earlier in it still counts as read: read a ` +
      'file again before editing it.',
  };
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

/** One loaded graph, keyed by the slug its document and its journal are both filed under. */
interface LoadedGraphDoc extends LoadedGraph {
  slug: GraphSlug;
}

/** The output node a run targets when none is named, which is the first one still active. */
function activeOutputOf(graph: GenGraph): GraphId | undefined {
  return activeOutputs(graph)[0]?.id;
}

/** What a run reaches the outside world through, whether it runs tasks or a generation graph. */
interface GenDeps {
  providers: Providers;
  /** The byte-level seam a graph's image nodes call, beneath the provider the runners use. */
  imageBackend: ImageBackend;
  /** Absent under `mock`, where nothing is resolved and no vendor is reached. */
  keys?: ResolvedKeys;
}

async function buildGenDeps(project: LoadedProject, mock: boolean): Promise<GenDeps> {
  const loadRef = async (ref: { hash: string; ext: string }) => ({
    bytes: await project.store.read(ref),
    ext: ref.ext,
  });
  if (mock) {
    const imageBackend = new StubImageBackend();
    return { providers: createMockProviders({ refLoader: loadRef, imageBackend }), imageBackend };
  }
  // `gemini` is required because the pipeline's image tasks cannot run without it; the chat
  // backends degrade more gracefully and are checked where they are built.
  const keys = await resolveKeys(project.config, {
    secretsDirs: await secretDirsFor(project.dir),
    require: ['gemini'],
  });
  return {
    providers: createProviders({ config: project.config, keys, loadRef }),
    imageBackend: createImageBackend(project.config, keys),
    keys,
  };
}

async function buildProviders(project: LoadedProject, mock: boolean): Promise<Providers> {
  return (await buildGenDeps(project, mock)).providers;
}

/** Backend state for a single workspace, addressed by the IPC handlers in `index.ts`. */
export class WorkspaceSession {
  private agent: Agent | undefined;
  private bibleWorkspace: Workspace | undefined;
  /** The text model the agent is bound to (what a future `/model` would report). */
  model = '';
  /** The reasoning effort the backend is built with. Always an explicit value, so the app never
   * silently inherits a vendor default. */
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
  /**
   * Set for as long as generative work is interruptible; `stopPipeline` is the one caller. A pass
   * holds one for all of its rounds, and the runs inside it share that one rather than making
   * their own.
   */
  private cancel: AbortController | undefined;

  /**
   * The conversation as main sees it, reduced by the functions the renderer runs — so what is
   * written down and what is on screen are derived from one definition rather than two.
   */
  private convo: Convo = emptyConvo('');
  /** The thread being written to. Opened by the first turn, never by opening the app. */
  private thread: ThreadHeader | undefined;
  /**
   * The native log's state for the open thread: which protocol the backend speaks, the sections
   * the next header line will carry, how many messages have been appended, whether that header has
   * been written yet, and how far a compaction has covered.
   */
  private native = {
    kind: 'mock' as BackendKind,
    sections: [] as SystemSection[],
    n: 0,
    opened: false,
    /** The highest `n` the newest summary replaces. Undefined until the author compacts. */
    compactedTo: undefined as number | undefined,
  };
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
   * Which API call the next receipt belongs to, counted from 1 and reset when a thread is opened.
   * A turn spends several calls, so a receipt needs an index of its own to be lined up against the
   * transcript without matching timestamps.
   */
  private step = 1;
  /**
   * The redactor the last report was written with, kept so the leak scan runs against the same
   * pseudonym table rather than a freshly built one — a different table is a different set of
   * names, and the question being asked is whether this report still says one.
   */
  private redaction: Redactor | undefined;
  /**
   * The debug conversation, while one is open. Held here for the reason {@link cancel} is: a stop
   * arrives from a command that is not the one running the turn it stops.
   */
  private analyst: Analyst | undefined;
  /**
   * What the open debug conversation was assembled from. A grant made part way through builds its
   * tools against these, so it reads the evidence the conversation started with and spends the
   * budget the earlier turns have already drawn on.
   */
  private analysis:
    | { req: AnalysisRequest; parts: AnalysisParts; thread: ThreadHeader }
    | undefined;
  /** Every row of the open debug conversation, in order. What `report.state` returns. */
  private reportRows: ReportRow[] = [];
  /** Which access has been granted. One-way, so neither ever goes back to false. */
  private reportGrants = { source: false, detail: false };
  /** Where the open debug conversation is being written down, when there was somewhere to write it. */
  private transcript: Transcript | undefined;

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
   * Ask the generative work in flight to stop. It stops at a task boundary, so this returns what
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
  private permission(): Permission {
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
   * Write one call's receipt to the active thread, and advance the step count. Separate from
   * `record` because a receipt is not a transcript line, and chained through the same promise so a
   * receipt lands between the lines it was earned between. Warns rather than throws, for the same
   * reason `record` does.
   */
  private recordUsage(event: Extract<AgentEvent, { type: 'usage' }>): void {
    const step = this.step++;
    const id = this.thread?.id;
    if (!id) return;
    const paths = new ProjectPaths(this.dir);
    const usage: ThreadUsage = {
      step,
      input: event.input,
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
  private writeNative(id: string, line: NativeLine): void {
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
  private recordMessage(message: AgentMessage): void {
    const id = this.thread?.id;
    if (!id) return;
    if (!this.native.opened) {
      this.native.opened = true;
      this.writeNative(id, {
        v: NATIVE_VERSION,
        type: 'resume',
        thread: id,
        at: new Date().toISOString(),
        backend: this.native.kind,
        vendor: chatVendorFor(this.model),
        sections: this.native.sections,
        ...(this.model === '' ? {} : { model: this.model }),
        ...(this.effort === undefined ? {} : { effort: this.effort }),
      });
    }
    const { role, content, toolUseId } = message;
    this.writeNative(id, {
      type: 'msg',
      n: this.native.n++,
      at: new Date().toISOString(),
      role,
      content,
      ...(toolUseId === undefined ? {} : { toolUseId }),
    });
  }

  /**
   * The backend for the next turn. A chat backend that can hold a conversation gets the native
   * backend, which is the cached path. Every other backend gets the text path.
   *
   * The probe is `chatConversation` and deliberately not `chatWithTools`: Gemini implements the
   * latter, and moving it onto the native path would give it a larger tools block for a request
   * that is still single-shot and still caches nothing.
   */
  private async buildBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    const backend = await this.chooseBackend(config, model);
    // Kept here because `Agent` does not expose the backend it was handed, and the native log has
    // to record which protocol its messages are in for a later resume to refuse the wrong one.
    this.native.kind = backend.kind;
    return backend;
  }

  private async chooseBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    if (this.mock) return new MockAgentBackend();
    const modelId = model ?? config.models.text;
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(this.dir),
      require: [chatVendorFor(modelId)],
    });
    const chat = chatBackendFor(modelId, keys, this.effort).backend;
    return chat.chatConversation ? new NativeAgentBackend(chat) : new StructuredAgentBackend(chat);
  }

  /**
   * The history `search_history` and `read_history` read: the open conversation's native log,
   * which keeps every message a compaction replaced. It is resolved per call rather than captured,
   * because the agent outlives the thread that is open in it, and a thread that has not been
   * written yet has nothing to search.
   */
  private history(): HistoryReader {
    return {
      messages: async () => {
        const id = this.thread?.id;
        if (!id) return [];
        const log = await readNative(new ProjectPaths(this.dir), id).catch(() => undefined);
        return log?.messages ?? [];
      },
    };
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
      text: workspaceTextLLM(workspace, { mock: this.mock }),
      // Approval is authorized by the author's own words, so this seam carries the model that
      // reads them alongside the two acts it gates.
      approval: {
        list: () => this.approvable(),
        approve: (item) => this.approveOne(item),
        triage: () => this.triageBackend(),
      },
      // The capability `vnauthor` does not have: the same two calls `asset.regenerate` makes, so
      // an agent-started re-render takes the busy flag a pipeline run takes.
      pipeline: {
        regenerate: (hash) => this.regenerateAsset(hash),
        run: async () => {
          const result = await this.runPipeline(this.mock);
          return { ran: result.ran, failed: result.failed, blockedOnGate: result.blockedOnGate };
        },
      },
      // Reading and editing a graph need no host, so only the run is wired here. It is the same
      // pair of calls `gengraph.run` makes, priced by the same sentence the author confirms.
      graphs: {
        estimate: async (slug) => {
          const counted = await this.graphEstimate(slug);
          return counted.ok
            ? { ok: true, note: estimateSentence(counted.estimate, counted.stale) }
            : { ok: false, reason: counted.reason };
        },
        run: (slug, opts) => this.runGraph(slug, { force: opts.force, mock: this.mock }),
      },
    };
    const context = await loadContext(this.dir);
    const config = await loadConfig(this.dir);
    this.model = config.models.text;
    this.agent = new Agent({
      backend: await this.buildBackend(config),
      ctx,
      registry: createRegistry(historyTools(this.history())),
      permission: this.permission(),
      system: composeSystem(context),
      budget: this.budget,
      onEvent: (event) => {
        this.record((convo) => received(convo, event));
        if (event.type === 'usage') this.recordUsage(event);
        this.deps.emitEvent(event);
        if (event.type === 'api') this.announceApi(event);
      },
      onApiError: (failure) => this.recoverApi(failure),
      onMessage: (message) => this.recordMessage(message),
    });
    return this.agent;
  }

  /**
   * A call to the model failed. Put it to the author with what can be done about it, once — the
   * answer buys a grant of attempts, and the loop spends them without asking again.
   *
   * A second failure after the grant is spent does not ask again: the author already chose a
   * recovery and it did not work, so re-offering the same three options would just repeat the
   * question. The turn ends instead; the conversation is intact, so resending it is one
   * keystroke.
   */
  private async recoverApi(failure: ApiFailure): Promise<ApiRecovery> {
    if (failure.attempt > 1) return { do: 'stop' };
    // Offer every curated model except the one that just failed — switching to the failed model
    // would retry the same request against the same backend.
    const others = TEXT_MODELS.filter((id) => id !== this.model);
    const question = apiRecoveryQuestion(failure, this.model, others);
    const [answer = ''] = await this.deps.requestAnswer([question]);
    const plan = readApiPlan(answer, others);
    if (plan.do === 'switch') {
      // Before the retry rather than after it: the loop re-reads the backend every attempt, so a
      // model swapped here is the one the next attempt is made against. It gets one try, so a
      // model the author picked that also fails is reported rather than retried repeatedly.
      await this.setModel(plan.model);
      return { do: 'retry', times: 1 };
    }
    if (plan.do === 'report') {
      // The turn ends either way: a diagnosis reads the request that failed, and another attempt
      // would only put a second one in front of it.
      this.deps.offerDiagnosis?.({
        ...(this.thread ? { thread: this.thread.id } : {}),
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
  private announceApi(event: Extract<AgentEvent, { type: 'api' }>): void {
    const tries = (n: number): string => `${n} failed attempt${n === 1 ? '' : 's'}`;
    if (event.phase === 'recovered') {
      void notify({
        category: 'agent',
        source: 'agent',
        message: `The model answered after ${tries(event.attempt)}.`,
      });
    } else if (event.phase === 'gaveup') {
      void notify({
        category: 'error',
        level: 'error',
        source: 'agent',
        message: `Gave up on the model after ${tries(event.attempt)}: ${event.message}`,
      });
    }
  }

  // ---- IPC-facing methods ----

  index(): Promise<WorkspaceIndex> {
    return new Workspace(this.dir).index();
  }

  /** Where the agent's generated project map lives, and whether it is ours to replace. */
  generatedContext(): Promise<GeneratedContextState> {
    return new Workspace(this.dir).generatedContext();
  }

  /** Rebuild the generated project map. Throws if a file already sits at the path and the
   * generator did not write it. */
  writeGeneratedContext(): Promise<{ file: string; counts: GeneratedCounts }> {
    return new Workspace(this.dir).writeGeneratedContext();
  }

  /**
   * Rewrite the map if a turn made it stale, before the next turn is composed. It never throws:
   * if the file at that path was not written by the generator it is somebody's own note, and the
   * right response is to leave it alone and log a warning — not to fail the turn the map was
   * about to help.
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
    return this.while(BUSY_AGENT, async () => {
      const agent = await this.ensureAgent();
      await this.refreshProjectMap();
      // This session outlives every rewrite of the project map, the agent's own `update_context`
      // included, so the map is re-read per turn and never outranks the tool output. Refreshed
      // section by section, so a rewrite supersedes itself rather than invalidating the cached
      // prefix.
      const sections = systemSections(await loadContext(this.dir));
      const delta = agent.refreshSystem(sections);
      this.noteSections(sections, delta);
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
   * Keep the native log's copy of the system prompt current. This runs before the turn's thread
   * exists, so on a thread's first turn the sections go into the header line the first message
   * writes, and from the second turn on a change is appended as a delta.
   */
  private noteSections(sections: SystemSection[], delta: SectionDelta | undefined): void {
    this.native.sections = sections;
    const id = this.thread?.id;
    if (!id || !this.native.opened || !delta) return;
    this.writeNative(id, {
      type: 'sections',
      n: this.native.n,
      at: new Date().toISOString(),
      set: delta.set,
      unset: delta.unset,
    });
  }

  /**
   * Make sure there is a thread to write to. Because only a turn opens one, the first thing the
   * author said is already known when the header is written and can be its title outright — the
   * provisional title is what a thread keeps only until someone talks in it.
   *
   * A thread that cannot be opened costs a warning and nothing else: the conversation still
   * works on a read-only volume, it just is not saved.
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
        ...(this.effort === undefined ? {} : { effort: this.effort }),
      });
      this.step = 1;
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
    await this.noteBinding();
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
    await this.noteBinding();
    if (this.mock) return effort;
    const agent = await this.ensureAgent();
    agent.setBackend(await this.buildBackend(await loadConfig(this.dir), this.model || undefined));
    return effort;
  }

  /**
   * Write the current binding into the open thread, if there is one. A switch made before anyone
   * has said anything writes nothing — the thread that has not been opened yet will carry the
   * binding on its own line 0 — and a thread on a read-only volume costs a warning, like every
   * other write here.
   */
  private async noteBinding(): Promise<void> {
    if (!this.thread) return;
    const binding = {
      ...(this.model === '' ? {} : { model: this.model }),
      ...(this.effort === undefined ? {} : { effort: this.effort }),
    };
    this.thread = { ...this.thread, ...binding };
    try {
      await bindThread(new ProjectPaths(this.dir), this.thread.id, binding);
    } catch (err) {
      console.warn(`[vnstudio] could not record the conversation's model: ${String(err)}`);
    }
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
   * The system prompt the next turn will carry, in its sections.
   *
   * Assembled from the project rather than read off `this.agent`, and deliberately so: `runAgent`
   * calls `refreshSystem(systemSections(await loadContext(...)))` before every turn, so this is
   * exactly what the next turn sends — and it can be answered before an agent has ever been
   * built, which is when an author most wants to check what it was told.
   */
  async systemPrompt(): Promise<AgentSystem> {
    const context = await loadContext(this.dir);
    return {
      sections: systemSections(context).map((section) => ({ ...section })),
      files: context.files,
      modelId: this.model,
    };
  }

  /**
   * Start over. The thread is closed rather than deleted — a conversation that happened stays on
   * disk, and the next turn opens a new one — and it is committed on the way out, so that what
   * stays on disk also stays in history.
   */
  async clearAgent(): Promise<void> {
    (await this.ensureAgent()).clear();
    await this.writes;
    await this.commitThread();
    this.thread = undefined;
    this.convo = emptyConvo('');
    // The next thread opens its own log, from message zero and with its own header.
    this.native = { ...this.native, sections: [], n: 0, opened: false, compactedTo: undefined };
  }

  /**
   * Put the conversation being closed into the project's history, and write down where it landed.
   *
   * Clearing is the moment a transcript stops being watched: nothing appends to that file again,
   * and the next thing to touch `vngen/state/` may well be an author tidying it. A commit here is
   * what makes "what did the agent do last Tuesday" answerable at all — the `Vn-Thread` trailer
   * is how a diagnostic finds it (`git log --grep`), and the pointer written back into the thread
   * is how it finds it without searching.
   *
   * Never fatal. A project that is not a repo, a repo with no committer identity, a read-only
   * volume: none of those are reasons to refuse to start a new conversation.
   */
  private async commitThread(): Promise<void> {
    const thread = this.thread;
    if (!thread) return;
    const paths = new ProjectPaths(this.dir);
    try {
      const git = openGit(this.dir);
      if (!(await git.isRepo())) return;
      const file = threadFile(paths, thread.id);
      // Both files in one commit, so a conversation and the history that makes it resumable are
      // never in the project separately. `lastCommitFor` still asks about the display log, which
      // is the file every thread has.
      const native = nativeFile(paths, thread.id);
      const hasNative = await exists(native);
      // Nothing to commit means commit-on-save already recorded this transcript, so the answer is
      // the commit that did — the pointer records where the conversation is, not who put it there.
      const sha =
        (await git.commit({
          message: `Close conversation: ${thread.title}`,
          paths: hasNative ? [file, native] : [file],
          trailers: { 'Vn-Thread': thread.id },
        })) ?? (await git.lastCommitFor(file));
      if (sha) await archiveThread(paths, thread.id, sha);
    } catch (err) {
      console.warn(`[vnstudio] could not commit the conversation just closed: ${String(err)}`);
    }
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
   * A saved conversation, for reading. It ends the live one: the model is never shown what comes
   * back, so leaving the previous turns in its context while the screen shows another
   * conversation would leave the author and the agent talking about different things.
   */
  async openThreadForReading(id: string): Promise<OpenedThread> {
    const record = await readThread(new ProjectPaths(this.dir), id);
    await this.clearAgent();
    // Reopened on the binding it was recorded with, because a conversation reads as the model
    // that wrote it. Nothing is written here — `clearAgent` has already closed the live thread,
    // and the next turn opens a thread carrying this binding on its own line 0.
    if (record.model && record.model !== this.model) await this.setModel(record.model);
    if (record.effort && (EFFORT_CHOICES as readonly string[]).includes(record.effort)) {
      await this.setEffort(record.effort as EffortChoice);
    }
    const { state } = await this.resumeState(id);
    return { ...record, resume: state };
  }

  /**
   * What thread `id`'s stored history says about continuing it, and the log the answer came from.
   *
   * A log a merge damaged is reported rather than thrown: the answer is a refusal either way, and
   * the refusal has to reach a greyed button as a sentence.
   */
  private async resumeState(id: string): Promise<{ state: ResumeState; log?: NativeLog }> {
    try {
      const log = await readNative(new ProjectPaths(this.dir), id);
      return log ? { state: { header: log.header }, log } : { state: {} };
    } catch (err) {
      if (err instanceof ConflictedLogError) return { state: { damaged: true } };
      throw err;
    }
  }

  /**
   * Why thread `id` cannot be continued on the binding in force, or `undefined`. What
   * `agent.resumeThread` refuses with, and what its menu entry is greyed with.
   *
   * The agent is built first because building the backend is what settles which protocol it speaks
   * and which model it is bound to, and both are what the stored conversation is checked against.
   */
  async resumeRefusalFor(id: string): Promise<string | undefined> {
    const record = await readThread(new ProjectPaths(this.dir), id);
    if (this.thread?.id === id) {
      return `“${record.title}” is already the open conversation.`;
    }
    await this.ensureAgent();
    const { state } = await this.resumeState(id);
    return resumeRefusal(record.title, state, { model: this.model, backend: this.native.kind });
  }

  /**
   * Continue a saved conversation: hand the agent the messages it was recorded with, then bind the
   * session to the thread they came from so later turns append to the same two files.
   *
   * Continuing happens on the model bound now rather than the one the conversation was recorded
   * with. `setModel` already promises a mid-conversation swap keeps the transcript, and the check
   * above has already refused a swap the stored messages could not survive.
   */
  async resumeThread(id: string): Promise<ThreadRecord> {
    const paths = new ProjectPaths(this.dir);
    const record = await readThread(paths, id);
    const agent = await this.ensureAgent();
    const { state, log } = await this.resumeState(id);
    const refusal = resumeRefusal(record.title, state, {
      model: this.model,
      backend: this.native.kind,
    });
    if (refusal) throw new Error(refusal);
    if (!log) throw new Error(`“${record.title}” has no history to continue from`);

    // Closes and commits whatever was open first, because `restore` replaces the transcript and a
    // half-written thread left bound would take the resumed conversation's later lines.
    await this.clearAgent();
    agent.restore({
      messages: [...restorable(liveMessages(log)), resumedNote(record)],
      sections: log.sections,
    });

    const { items, compactions, ...header } = record;
    this.thread = header;
    this.convo = replayed(this.convo, items, '', compactions);
    // Past the highest `n` the log holds, so a message written now cannot take the number of one
    // already in the file. The header is not rewritten: line 0 still describes this conversation.
    const highest = log.messages.reduce((max, message) => Math.max(max, message.n), -1);
    this.native = {
      ...this.native,
      sections: log.sections,
      n: highest + 1,
      opened: true,
      compactedTo: log.compaction?.covers.to,
    };
    return record;
  }

  /**
   * Why the open conversation cannot be compacted, or `undefined`. What `agent.compact` refuses
   * with, and what its button is greyed with.
   *
   * The third case is the one worth naming: a turn that ended part way through a tool call cannot
   * be compacted, because the summary would cover messages the agent is still holding, and the
   * live conversation and the log would then disagree about what has been replaced.
   */
  async compactRefusalFor(): Promise<string | undefined> {
    if (!this.thread) return 'Nothing has been said in this conversation yet.';
    const live = (await this.ensureAgent()).transcript;
    const cut = lastCompleteTurn(live);
    if (cut < 0) return 'This conversation has no finished turn to summarize yet.';
    if (cut !== live.length - 1) {
      return 'The last turn stopped part way through a tool call. Send another turn first.';
    }
    if (this.native.compactedTo === this.native.n - 1) {
      return 'This conversation was compacted already, and nothing has been said since.';
    }
    return undefined;
  }

  /**
   * Compact the open conversation: summarize everything said so far on the model the conversation
   * is bound to, hand the agent the summary in place of the messages, and append both records.
   *
   * Nothing is rewritten. The summary is one more line in each log, so the transcript on screen is
   * unchanged and a later resume reads the summary plus whatever was said after it. The read
   * ledger goes with the messages, which `compactionMessage` tells the agent about.
   */
  async compactThread(): Promise<CompactionMark> {
    return this.while(BUSY_AGENT, async () => {
      const refusal = await this.compactRefusalFor();
      if (refusal) throw new Error(refusal);
      const thread = this.thread;
      if (!thread) throw new Error('no conversation is open');

      const agent = await this.ensureAgent();
      const covered = [...agent.transcript];
      const backend = await this.buildBackend(await loadConfig(this.dir), this.model || undefined);
      const turn = await backend.next(COMPACTION_SYSTEM, compactionPrompt(covered), []);
      // A backend with nothing to call answers in `final`; `message` covers one that narrates
      // instead, so a summary is never lost to which field it arrived in.
      const summary = (turn.final ?? turn.message ?? '').trim();
      if (!summary) throw new Error('the model returned no summary, so nothing was compacted');

      // The call's own cost is reported before the compaction lands, because `compacted` drops the
      // context figure and this event would otherwise set it again from the prefix just replaced.
      if (turn.usage) {
        const event: AgentEvent = { type: 'usage', ...turn.usage };
        this.record((convo) => received(convo, event));
        this.deps.emitEvent(event);
      }

      const { messages } = compactRange(covered, summary);
      const head = messages[0];
      if (!head) throw new Error('the summary could not be built');
      const mode = agent.currentMode;
      agent.restore({ messages, sections: this.native.sections });
      // `restore` clears the agent, which puts it back in plan mode. The summary replaces what was
      // said, not the author's decision about what the agent may do.
      agent.setMode(mode);

      const at = new Date().toISOString();
      const to = this.native.n - 1;
      this.native.compactedTo = to;
      this.writeNative(thread.id, {
        type: 'compact',
        covers: { from: 0, to },
        role: head.role,
        content: typeof head.content === 'string' ? head.content : JSON.stringify(head.content),
        at,
        ...(this.model === '' ? {} : { model: this.model }),
        ...(turn.usage ? { usage: { input: turn.usage.input, output: turn.usage.output } } : {}),
      });

      const mark: CompactionMark = {
        afterId: this.convo.feed[this.convo.feed.length - 1]?.id ?? 0,
        covers: covered.length,
        text: summary,
        at,
        ...(this.model === '' ? {} : { model: this.model }),
      };
      this.convo = compacted(this.convo, mark);
      const paths = new ProjectPaths(this.dir);
      this.writes = this.writes
        .then(() => appendCompaction(paths, thread.id, mark))
        .catch((err: unknown) => {
          console.warn(`[vnstudio] could not record the compaction: ${String(err)}`);
        });
      await this.writes;
      return mark;
    });
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
   * The model and effort one analysis runs at. An empty field means whatever the agent is bound
   * to, so a scripted `report.agent(thread='t3')` does the sensible thing without naming a
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

  /** The conversation an analysis would read. The one named, or the newest when none is named. */
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
   * disabled control shows verbatim, and the key one is keyed to the chosen model — switching
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
    // Said before it is run rather than discovered afterwards: with nothing captured the box is
    // ticked for no benefit, and an analyst told it can read requests that do not exist wastes
    // turns finding that out.
    if (ask.detail && captureSnapshot().headers().length === 0) {
      return {
        ok: false,
        message:
          'Nothing was sent to the model API in this session, so there are no requests to read. ' +
          'Untick reading the requests.',
      };
    }

    const advice = adviseRun(modelId, effort ?? this.effort, ask.source, this.effort);
    const also = ask.detail ? ' It also reads the requests this session sent.' : '';
    return {
      ok: true,
      message: `Reads “${target.header.title}” with ${modelId}.${advice ? ` ${advice}` : ''}${also}`,
    };
  }

  /**
   * The tools the agent under report could call. Read off the live agent when this window has run
   * a turn, since a host may add to the registry; otherwise from the same default `ensureAgent`
   * builds one from, because a reopened thread can be reported without a turn ever running here.
   */
  private agentTools(): { name: string; description: string }[] {
    if (this.agent) return this.agent.tools;
    return [...createRegistry().values()].map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /**
   * Analyse a conversation that went wrong. Long — a minute or two, more with the source — so it
   * takes the busy flag every other long act does, and the dialog closes rather than being held
   * open across it.
   */
  async reportAgent(ask: ReportAsk): Promise<ReportDraft> {
    const { req } = await this.analysisRequest(ask);
    return this.while(BUSY_REPORT, async () => {
      const { report, evidence, redactor } = await analyseThread(req);
      this.redaction = redactor;
      const body = renderReport(report, evidence);
      return { report, title: reportTitle(report), body, ...(await this.keepReport(body)) };
    });
  }

  /**
   * Everything an analysis is asked for, resolved: which conversation, which model, which key.
   * Shared by the one-shot report and the conversation, so neither can read a different thread or
   * resolve a key the other would not have found.
   */
  private async analysisRequest(
    ask: ReportAsk,
  ): Promise<{ req: AnalysisRequest; header: ThreadHeader }> {
    const target = await this.reportTarget(ask);
    if (!target.ok) throw new Error(target.message);

    const project = await loadProject(this.dir);
    const { modelId, effort } = this.analysisBinding(project.config, ask);
    const keys = await resolveKeys(project.config, {
      secretsDirs: await secretDirsFor(this.dir),
      require: [chatVendorFor(modelId)],
    });

    return {
      header: target.header,
      req: {
        dir: this.dir,
        paths: project.paths,
        config: project.config,
        model: project.model,
        keys,
        threadId: target.header.id,
        modelId,
        source: ask.source,
        reportedTools: this.agentTools(),
        ...(ask.detail ? { detail: true } : {}),
        ...(effort ? { effort } : {}),
        ...(ask.note.trim() ? { wanted: ask.note } : {}),
        ...(this.deps.appVersion ? { appVersion: this.deps.appVersion } : {}),
        ...(this.deps.userData ? { userData: this.deps.userData } : {}),
      },
    };
  }

  /**
   * Start a debug conversation about one thread and run its opening turn. Whatever was open is
   * dropped: there is one analyst per app instance, so every window that opens the pane follows
   * the same transcript rather than starting a second analysis of the same thread.
   */
  async openReport(ask: ReportAsk): Promise<ReportStateView> {
    const { req, header } = await this.analysisRequest(ask);
    const parts = await analysisParts(req);
    this.analysis = { req, parts, thread: header };
    this.reportRows = [];
    this.reportGrants = { source: req.source, detail: req.detail === true };
    this.transcript = await this.beginTranscript(req, header.id);
    this.redaction = parts.redactor;
    this.analyst = createAnalyst({
      ...parts.options,
      host: {
        ask: (form) => this.deps.requestAnswer([...form]),
        onEvent: (event) => this.showReport(event),
      },
    });
    // The evidence is the opening message rather than a row, because the pane draws the setup card
    // in its place — the author has not said anything yet
    await this.reportTurn(openingMessage(parts.options));
    return this.reportState();
  }

  /**
   * Start writing this conversation down, or carry on without one. A transcript is for reading back
   * later, so failing to open one is not a reason to refuse an analysis the author is waiting on.
   *
   * The conversation's id is written rather than its title, because a title is the author's own
   * words and nothing outside the redacted evidence has been through the redactor.
   */
  private async beginTranscript(
    req: AnalysisRequest,
    thread: string,
  ): Promise<Transcript | undefined> {
    try {
      const transcript = await openTranscript();
      transcript.write({
        kind: 'opened',
        thread,
        model: req.modelId,
        source: req.source,
        detail: req.detail === true,
        ...(req.effort ? { effort: req.effort } : {}),
      });
      return transcript;
    } catch {
      return undefined;
    }
  }

  /** Add one row to the conversation, and to the file it is being written down in. */
  private recordReport(row: ReportRow): void {
    this.reportRows.push(row);
    this.transcript?.row(row);
  }

  /** One more message to the open conversation, and the turn it starts. */
  async sayToReport(text: string): Promise<ReportStateView> {
    this.recordReport({ kind: 'said', text });
    await this.reportTurn(text);
    return this.reportState();
  }

  /**
   * Run one turn. Each turn takes the busy flag rather than the conversation taking it once, so an
   * open pane does not make the session busy for as long as it sits there.
   *
   * A report filed by the turn is rendered and archived here, on the same terms as the one-shot
   * path: the pane cannot render one itself, and a second report supersedes the first on disk
   * without disturbing the card the first one left in the transcript.
   */
  private reportTurn(text: string): Promise<void> {
    const analyst = this.analyst;
    if (!analyst) throw new Error(NO_REPORT);
    const evidence = this.analysis?.parts.evidence;
    return this.while(BUSY_REPORT, async () => {
      const turn = await analyst.ask(text);
      if (!turn.report || !evidence) return;
      const body = renderReport(turn.report, evidence);
      this.recordReport({
        kind: 'filed',
        report: turn.report,
        title: reportTitle(turn.report),
        body,
        ...(await this.keepReport(body)),
      });
    });
  }

  /**
   * Record one event of the turn in flight and push it to every window. It arrives redacted, so
   * what is kept and what is shown carry pseudonyms the same way the finished report does.
   */
  private showReport(event: AgentEvent): void {
    this.recordReport({ kind: 'event', event });
    if (event.type === 'tool') {
      this.progress = { ran: this.progress.ran + 1, pending: 0 };
      this.announceBusy();
    }
    this.deps.emitReport(event);
  }

  /**
   * What granting one kind of access would do, without doing it. Each refusal is a sentence a
   * ticked-and-disabled box shows verbatim. The requests are counted off the snapshot the analysis
   * froze rather than off the live ring, because that is what a grant would actually hand over.
   */
  async previewGrant(kind: AnalystGrant['kind']): Promise<PromptResult> {
    const open = this.analysis;
    if (!open || !this.analyst) return { ok: false, message: NO_REPORT };
    if (this.reportGrants[kind]) {
      return {
        ok: false,
        message:
          kind === 'source'
            ? 'The debug agent has already been shown the source.'
            : 'The debug agent has already been shown the requests.',
      };
    }
    if (kind === 'source' && !(await sourceRoot())) return { ok: false, message: NO_SOURCE };
    if (kind === 'detail' && open.parts.snapshot.headers().length === 0) {
      return {
        ok: false,
        message:
          'Nothing was sent to the model API in this session, so there are no requests to read.',
      };
    }
    return {
      ok: true,
      message:
        kind === 'source'
          ? 'The debug agent gets the source with your next message.'
          : 'The debug agent gets the requests with your next message.',
    };
  }

  /**
   * Give the open conversation more to read. The tools are advertised from the next turn, so this
   * is accepted while a turn is in flight and lands behind it.
   */
  async grantReport(kind: AnalystGrant['kind']): Promise<ReportStateView> {
    const open = this.analysis;
    if (!open || !this.analyst) throw new Error(NO_REPORT);
    this.analyst.grant(
      kind === 'source' ? await sourceGrant(open.req, open.parts.budget) : detailGrant(open.parts),
    );
    this.reportGrants[kind] = true;
    this.transcript?.write({ kind: 'granted', access: kind });
    return this.reportState();
  }

  /**
   * The conversation as main holds it. A pane that mounts part way through asks for this and
   * reduces the rows the way it reduces live events, so there is one reducer rather than a second
   * read path that can disagree with it.
   */
  reportState(): ReportStateView {
    const open = this.analysis;
    return {
      ...(open ? { thread: { id: open.thread.id, title: open.thread.title } } : {}),
      busy: this.running(BUSY_REPORT),
      granted: { ...this.reportGrants },
      rows: [...this.reportRows],
    };
  }

  /**
   * Archive the report, and report no file when that fails. The author has the analysis on screen
   * either way, and a copy they did not ask for is not worth withholding the analysis they paid a
   * minute and a model call for.
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
   * The redactor used to scan a report body. Normally this is the cached one left behind by the
   * analysis that wrote the report; when no analysis ran in this process (a scripted
   * `report.openIssue(body='…')`), one is built fresh from the current project. Building one
   * costs a full project load, so the result is cached rather than rebuilt on every preview
   * keystroke.
   */
  private async reportRedaction(): Promise<Redactor> {
    if (!this.redaction) {
      const project = await loadProject(this.dir);
      this.redaction = makeRedactor(this.dir, project.model);
    }
    return this.redaction;
  }

  /**
   * What `report.openIssue` would do. Refuses if the leak scan finds any name the redactor knows
   * still in the body — that name would otherwise end up in a public issue tracker — and the
   * refusal message names it so the author can find it rather than hunt for it.
   */
  async previewIssue(input: { title: string; body: string }): Promise<PromptResult> {
    if (!input.body.trim()) return { ok: false, message: 'There is no report to file.' };
    if (!input.title.trim()) return { ok: false, message: 'An issue needs a title.' };

    const leaked = (await this.reportRedaction()).leaks(input.body);
    if (leaked.length > 0) return { ok: false, message: leakSentence(leaked) };

    return {
      ok: true,
      message:
        'Copies the report to your clipboard and opens a new issue in your browser, for you to ' +
        'paste it into. Nothing is posted until you press Create.',
    };
  }

  /**
   * Put the whole report on the clipboard, then open GitHub's new-issue form prefilled with the
   * instruction to paste it. The clipboard write comes first deliberately: the browser is where
   * the author needs the report, and it has to already be in hand by then.
   *
   * The report itself never travels on the URL. A length limit that changed what the author had to
   * do is a limit they had to learn, so the form always says the same thing.
   *
   * The leak scan runs again here rather than trusting `previewIssue`: a caller may skip the
   * check (CDP can call this directly), and the one thing this must never do is publish a name.
   */
  async openIssue(input: { title: string; body: string }): Promise<IssueOpened> {
    const preview = await this.previewIssue(input);
    if (!preview.ok) throw new Error(preview.message);

    const open = this.deps.openExternal;
    if (!open) throw new Error('This build cannot open a browser.');

    const url = issueUrl({ title: input.title, body: PASTE_BODY });
    // Checks the URL that reaches the shell rather than trusting what `issueUrl` composed
    assertIssueUrl(url);

    this.deps.writeClipboard?.(input.body);
    await open(url.href);
    return { url: url.href };
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
   * Every picture that could be approved right now, upstream first — the same walk the document
   * tree's “Awaiting approval” group is a projection of, so the agent and the tree can never
   * disagree about what is waiting. A blocked row is still listed, with a sentence saying what
   * it is waiting on: the whole frontier is more useful than just the subset that happens to be
   * actionable this second.
   */
  async approvable(): Promise<Approvable[]> {
    const project = await loadProject(this.dir);
    const manifest = project.store.manifest();
    const labels = labelContext(project.model, project.graph);
    const shots = await readAllShots(project);
    const slots = buildSlotGraph({
      ...labels,
      assets: manifest,
      shots,
      config: project.config,
      graph: project.graph,
    });
    const names = labelAssets(manifest, labels);
    const byHash = new Map(manifest.map((a) => [a.hash, a]));
    const out: Approvable[] = [];
    const seen = new Set<string>();
    for (const key of slots.order) {
      const slot = slots.nodes.get(key);
      if (!slot) continue;
      for (const hash of slot.candidates) {
        const asset = byHash.get(hash);
        // One row per picture, as the tree does it: a sheet bound to two outfits is still one
        // thing to approve, and the first slot that names it is the one it is listed under.
        if (!asset || seen.has(hash) || assetApproved(asset, project.model)) continue;
        seen.add(hash);
        const label = names.get(hash) ?? hash;
        const characterId = asset.satisfies[0]?.characterId;
        // A portrait's refusal comes from the gate, not the accept rule, so only the accept door
        // asks about prerequisites — the same asymmetry `assetInfo` draws.
        const blocked =
          asset.kind === 'portrait'
            ? undefined
            : prereqRefusal(label, assetPrereqs(asset, { ...labels, assets: manifest, shots }));
        out.push({
          hash,
          kind: asset.kind,
          label,
          slot: slot.label,
          door: asset.kind === 'portrait' ? 'gate' : 'accept',
          ...(characterId === undefined ? {} : { characterId }),
          ...(blocked === undefined ? {} : { blocked }),
          // The slot's own asymmetric answer (gate for a portrait, `accepted` for everything
          // else), carried through so a caller approving in bulk can tell "nothing has settled
          // this yet" from "this is the take that lost".
          ...(slot.approved ? { settled: true } : {}),
        });
      }
    }
    return out;
  }

  /**
   * The same list, ordered for reading rather than for approving: whatever `previousOrder` has
   * not seen goes on top. The caller owns `previousOrder` because it outlives the session — it is
   * persisted per project, so the list survives a restart.
   */
  async approvalQueue(previousOrder: readonly string[]): Promise<ApprovalQueue> {
    return reorderApprovals(await this.approvable(), previousOrder);
  }

  /** Approve one `Approvable` through whichever door it belongs to. */
  async approveOne(item: Approvable): Promise<{ ok: boolean; message: string }> {
    if (item.door !== 'gate') return this.acceptAsset(item.hash);
    if (!item.characterId) {
      return {
        ok: false,
        message: `${item.label} is a portrait of nobody — nothing to clear.`,
      };
    }
    return this.approveCharacter(item.characterId, item.hash);
  }

  /**
   * The small model that reads the author's own words before art is approved on their say-so.
   * Fixed at {@link TRIAGE_MODEL} rather than following the conversation's model: this is a check
   * on the agent, and running it on the model being checked would not be a check. Returns
   * `null` in a mocked session, where `@vn/authoring`'s `offlineTriage` stands in and says so.
   */
  private async triageBackend(): Promise<ChatBackend | null> {
    if (this.mock) return null;
    const config = await loadConfig(this.dir);
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(this.dir),
      require: [chatVendorFor(TRIAGE_MODEL)],
    });
    return chatBackendFor(TRIAGE_MODEL, keys).backend;
  }

  /**
   * Every suspended asset, upstream first, with the reason for each. Derived on every call:
   * suspension is a walk over the manifest and the rungs, never a stored flag
   * (`docs/plans/archive/chunked-prompts.md` §13).
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
   * The task the project would run for a slot today, or `undefined` when the slot no longer
   * resolves. One slot is resolved rather than the whole graph, which is what keeps this cheap
   * enough for every read of the asset pane.
   */
  private slotTask(
    project: LoadedProject,
    binding: RefBinding,
    shots: ReadonlyMap<string, Shot[] | null>,
  ): string | undefined {
    const decided = resolveSlot(binding, {
      model: project.model,
      shots,
      config: project.config,
      graph: project.graph,
    });
    return decided.ok ? slotTaskHash(decided.plan) : undefined;
  }

  /**
   * Why the picture an asset fills is not finished, or `undefined` while it is still on its way.
   *
   * Two tasks are asked, in order. The slot's identity as the project states it today comes first,
   * because an art-notes edit gives the slot a new one and a run that fails on it leaves the last
   * good render on screen with nothing saying the re-render did not happen. The task these bytes
   * came from answers second, for the frame that was drawn and then flagged.
   */
  private failureOf(
    project: LoadedProject,
    current: string | undefined,
    sourceTask: string,
  ): AssetFailure | undefined {
    for (const hash of [current, sourceTask]) {
      if (!hash) continue;
      const task = project.graph.get(hash);
      if (!task || (task.status !== 'failed' && task.status !== 'needs_human')) continue;
      return {
        task: hash,
        status: task.status,
        ...(task.error === undefined ? {} : { error: task.error }),
        attempts: task.attempts.filter((a) => a.error).length,
        maxAttempts: project.config.max_task_attempts,
        later: hash !== sourceTask,
      };
    }
    return undefined;
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
    // The prompt as sent carries any `Corrections:` clause P7 appended; the planner hashed the base.
    const recorded = asset.prompt === undefined ? undefined : basePromptOf(asset.prompt);
    const view = await this.promptViewOf(project, hash);
    const labels = labelContext(project.model, project.graph);
    const label = labelAssets(manifest, labels).get(hash) ?? hash;
    const prereqs = assetPrereqs(asset, { ...labels, assets: manifest, shots });
    // Only for the kinds that can be accepted at all: a portrait, a concept and an upload are each
    // refused by name already, and a second sentence beside those reads as a second rule. Their
    // prereqs are still listed, because what a sketch was drawn from is worth showing regardless.
    const unapproved = ACCEPTABLE.has(asset.kind) ? prereqRefusal(label, prereqs) : undefined;
    const from = slotOf(asset, labels.angleOf?.(asset.sourceTask));
    const current = from ? this.slotTask(project, from, shots) : undefined;
    // A slot only counts while these are the bytes in it: a superseded render keeps its binding,
    // and a pane offering to replace a superseded render would supersede a picture already
    // moved past.
    const slot = from && task?.status === 'done' && task.output === asset.hash ? from : undefined;
    const failure = from ? this.failureOf(project, current, asset.sourceTask) : undefined;
    // Reported only once the bytes exist, so the pane never follows a hash the manifest cannot
    // answer for.
    const holder = current === undefined ? undefined : project.graph.get(current)?.output;
    const newer =
      holder !== undefined && holder !== asset.hash && manifest.some((a) => a.hash === holder)
        ? holder
        : undefined;
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
      stale: derived !== undefined && recorded !== undefined && derived !== recorded,
      ...(suspended ? { suspended: suspended.reason } : {}),
      ...(slot ? { slot: slotKey(slot) } : {}),
      ...(newer ? { newerTake: newer } : {}),
      ...(failure ? { failure } : {}),
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
      // Accepting says these bytes are the answer, and a suspended asset was drawn against a
      // reference that has since moved.
      return {
        ok: false,
        message: `${info.label} is suspended: ${info.suspended}. Repin or regenerate it first.`,
      };
    }
    // Checked after suspension deliberately: suspension is a claim about these bytes resting on a
    // reference that moved, which is more specific than a claim about other bytes upstream.
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
   * asks {@link previewAccept} itself rather than trusting that a check already ran — a caller
   * may skip the check, so the command cannot rely on it having happened.
   *
   * Accepting is exclusive per slot: the takes this one replaces are un-accepted in the same write,
   * because a slot with two accepted candidates cannot be resolved and reads as empty.
   */
  async acceptAsset(hash: string): Promise<{ ok: boolean; message: string }> {
    const allowed = await this.previewAccept(hash);
    if (!allowed.ok) return allowed;
    const project = await loadProject(this.dir);
    if (!project.store.has(hash)) return { ok: false, message: `No asset "${hash}" in the store.` };
    const assets = project.store.manifest();
    const asset = assets.find((a) => a.hash === hash);
    const ctx = { ...labelContext(project.model, project.graph), assets };
    await project.store.accept(hash, asset ? supersededBy(asset, ctx) : []);
    return { ok: true, message: `Accepted ${hash.slice(0, 8)}.` };
  }

  /**
   * Whether a regeneration would land, and the task it would requeue. Shared by the check and the
   * write so the refusal a surface shows is the refusal the command gives.
   *
   * A `stale` asset is refused on purpose: its task is an orphan (the prompt moved on, so the
   * planner now wants a different hash), and requeueing it would spend a real image call
   * reproducing the picture the author just edited away from. `tasks.jsonl` is never pruned, so
   * without this the log's dead nodes stay re-runnable forever. The one stale asset that is not
   * refused is one whose slot has since failed: there the task to re-run is the one that gave up,
   * and no run will reach it on its own once its retry budget is spent.
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
    // A re-render the project has already given up on is the picture the author is asking for,
    // not the one these bytes came from. The scheduler will not requeue it once its retry budget
    // is spent, and the orphan refusal below would send the author to a run that does nothing.
    if (info.failure?.later) {
      const later = project.graph.get(info.failure.task);
      if (later) {
        return {
          ok: true,
          task: later,
          note: `Would re-run the ${later.kind} that gave up on ${info.label}. The picture on screen is the last one that got through, and it stays until the new render lands.`,
        };
      }
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
   * snapshot to `tasks.jsonl` performs the requeue — `loadGraph` replays last-writer-wins, which
   * is how `requeueFailed` already works — so this needs no new scheduler machinery.
   *
   * A slot a generation graph draws needs a second step. The graph's own journal resumes every
   * node whose hash still matches, so requeuing the task alone would replay the same picture out
   * of the journal; the paid nodes upstream of that graph's output are invalidated as well.
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
    const written = [relPath(this.dir, project.paths.tasksLog)];
    const invalidated = await this.invalidateBound(project, decided.task);
    if (invalidated !== undefined) written.push(invalidated);
    return {
      ok: true,
      message: `Queued ${decided.task.kind} ${decided.task.hash.slice(0, 8)} for re-run.`,
      written,
    };
  }

  /**
   * Invalidates the paid nodes feeding the graph bound to this task's slot, and reports the
   * journal that was appended to. Answers undefined when no graph claims the slot, which is
   * every task in a project that has authored none.
   */
  private async invalidateBound(
    project: LoadedProject,
    task: AnyTask,
  ): Promise<string | undefined> {
    const slot = slotOfTask(task, project.model);
    if (slot === undefined) return undefined;

    const git = openGit(this.dir);
    for (const slug of await graphSlugs(this.dir)) {
      const read = await readGraph(this.dir, slug, git);
      if (!read.ok) continue;

      const bound = activeOutputs(read.graph).find((output) => output.slot === slot);
      if (bound === undefined) continue;

      await invalidateGenGraph(
        read.graph,
        { record: (record: GraphJournalRecord) => appendGraphJournal(project.paths, slug, record) },
        [bound.id],
      );
      return relPath(this.dir, graphJournalFile(project.paths, slug));
    }
    return undefined;
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
    // Only a whole-prompt rewrite can lose a clause; in chunks mode the text is the chunks, and
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
   * The `ChunkRef` an address would attach, and the cycle it would close if it closed one
   * (`docs/plans/archive/chunked-prompts.md` §14).
   *
   * Enforcement is here, at write time, rather than in the planner: refusing at plan time would mean
   * the project is already broken on disk and the author meets a run failure instead of a rejected
   * gesture. A bare hash attaches with no `from`, because an upload or a concept carries its own
   * identity: there is no slot under it, so it can never drift.
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
   * existing bytes (`docs/plans/archive/chunked-prompts.md` §13). Both the check and the write
   * ask this, so they cannot disagree.
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
   * Move a pinned reference to what its slot holds now. The adoption is decided first, then the
   * pin is written, then the adoption is logged — so a refusal leaves the pin where it was rather
   * than leaving a moved pin with no output.
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
   * Condense the chunks into one prompt and store it at the rung. The condensation is held the
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
    scope: KeyScope,
  ): Promise<{ path: string; shown: string; had: boolean; shadow: string }> {
    const file = secretFileFor(vendor);
    // The project scope is shown as a relative path because it sits inside the workspace the
    // author is looking at; the user scope is shown in full because it deliberately does not.
    const path = scope === 'user' ? join(userKeysDir(), file) : join(this.dir, 'keys', file);
    const shown = scope === 'user' ? path : `keys/${file}`;
    const envName = (await loadConfig(this.dir)).keys[vendor];
    const set = (process.env[envName] ?? '').trim() !== '';
    return {
      path,
      shown,
      had: await exists(path),
      shadow: set ? ` $${envName} is set and is read first, so the file goes unused.` : '',
    };
  }

  /** What `project.setKey` would do, without writing it. */
  async previewKey(vendor: keyof ResolvedKeys, scope: KeyScope = 'project'): Promise<PromptResult> {
    const { shown, had, shadow } = await this.keyFile(vendor, scope);
    const reach =
      scope === 'user' ? ' Every project on this machine reads it.' : ' This project reads it.';
    return {
      ok: true,
      message: `${had ? 'Replace' : 'Write'} the ${vendor} key in ${shown}.${reach}${shadow}`,
    };
  }

  /**
   * Store an API key. The value reaches exactly one file — the first name `resolveKeys` looks
   * for — and nothing else: not the message, not the log, and not `commands.jsonl`, where
   * `prop.secret` has already replaced it.
   *
   * At the project scope, `keys` is ignored before the write happens, because commit-on-save runs
   * `git commit -A` and would otherwise commit the file within the second. At the user scope
   * there is no repository to ignore it in — the directory is deliberately outside every one —
   * so the guard is the file mode instead: `0600` on POSIX. A project's `keys/` never needed
   * that because the repository boundary already kept it out of history.
   */
  async setKey(
    vendor: keyof ResolvedKeys,
    key: string,
    scope: KeyScope = 'project',
  ): Promise<PromptWriteResult> {
    const value = key.trim();
    if (!value) return { ok: false, message: 'No key given.', written: [] };

    const { path, shown, had, shadow } = await this.keyFile(vendor, scope);
    const ignored = scope === 'project' ? await ensureIgnored(this.dir, ['keys']) : false;
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${value}\n`);
    if (scope === 'user' && process.platform !== 'win32') {
      await chmod(path, 0o600).catch(() => undefined);
    }

    // The key file itself is never reported as written: it is ignored (or outside the repo
    // entirely), so nothing downstream may treat it as a document. The `.gitignore` is, because
    // it is committed.
    const safety = scope === 'user' ? ', which is outside every repository' : ', which git ignores';
    const reach =
      scope === 'user' ? ' Every project on this machine reads it.' : ' This project reads it.';
    return {
      ok: true,
      message: `${had ? 'Replaced' : 'Wrote'} the ${vendor} key in ${shown}${safety}.${reach}${shadow}`,
      written: ignored ? ['.gitignore'] : [],
    };
  }

  /**
   * For each vendor, whether a key resolved and which source answered — never the value. The
   * Setup pane is built on this, and so is the first-run check that decides whether to offer it.
   */
  async keyStatusView(): Promise<KeyStatusView> {
    const config = await loadConfig(this.dir);
    const status = await keyStatus(config, { secretsDirs: await secretDirsFor(this.dir) });
    const byVendor = new Map<string, VendorKeyStatus>(status.map((s) => [s.vendor, s]));
    return {
      userKeysDir: userKeysDir(),
      vendors: KEY_VENDORS.map((vendor) => {
        const s = byVendor.get(vendor);
        return {
          vendor,
          resolved: s?.resolved ?? false,
          source: describeKeySource(this.dir, s),
          envName: s?.envName ?? config.keys[vendor],
          envShadow: s?.envShadow ?? false,
          writesTo: {
            project: `keys/${secretFileFor(vendor)}`,
            user: join(userKeysDir(), secretFileFor(vendor)),
          },
        };
      }),
    };
  }

  /**
   * The key walkthrough, read from the one file that holds it and parsed into blocks.
   *
   * Parsed here rather than in the pane because main is the side with a filesystem: what crosses
   * the IPC boundary is already drawable, and the pane cannot end up with a second opinion about
   * what the page says.
   */
  async keyGuide(): Promise<KeyGuide> {
    return parseKeyGuide(await readResource('docs', 'guides', 'api-keys.md'));
  }

  /**
   * Open one of a vendor's pages — its key console, its documentation, its pricing — in the
   * system browser.
   *
   * The URL is looked up here, from the shipped guide, rather than passed in. A renderer that
   * could name any URL for the OS to open is a renderer that can be talked into opening one, and
   * nothing about these buttons needs that: the pages they may reach are three fields of a file
   * the app ships.
   */
  async openKeyLink(vendor: keyof ResolvedKeys, link: GuideUrlField): Promise<PromptResult> {
    const guide = await this.keyGuide();
    const url = guide.vendors.find((entry) => entry.vendor === vendor)?.[link] ?? '';
    if (!/^https:\/\//.test(url)) {
      return { ok: false, message: `The setup guide names no ${link} page for ${vendor}.` };
    }
    const open = this.deps.openExternal;
    if (!open) return { ok: false, message: 'This build cannot open a browser.' };
    await open(url);
    return { ok: true, message: `Opened ${url}.` };
  }

  /**
   * Ask GitHub whether there is a newer VN Studio than this one.
   *
   * The decision is `updates.ts`'s and is pure; this is the request. Unauthenticated, so it is
   * rate-limited at 60 an hour per IP — fine for one desktop app, which is why nothing automated
   * may ever call this.
   *
   * It never throws. Every failure comes back as an `unreachable` verdict carrying its own
   * sentence, because a check the author did not ask for must be able to fail without filing an
   * `error` notification at someone mid-scene. `announcementFor` is what decides whether the
   * verdict is worth saying out loud.
   */
  async checkForUpdates(): Promise<UpdateCheck> {
    const running = runningVersion(this.deps.appVersion ?? '');
    try {
      const response = await fetch(RELEASES_API, {
        headers: {
          accept: 'application/vnd.github+json',
          // GitHub asks every client to name itself, and answers 403 to one that does not.
          'user-agent': `vnstudio/${running || 'dev'} (+${RELEASES_PAGE})`,
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      // 403 and 429 are the rate limit, and 404 is a repository with no release yet. All three
      // are "no answer today" rather than anything the author can act on.
      if (!response.ok) return unreachable(running, `GitHub answered ${response.status}`);
      return checkAgainst(running, await response.json());
    } catch (err) {
      return unreachable(running, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Open VN Studio's own releases page — the notes and the installers are one page there.
   *
   * The address is derived from `ISSUE_REPO` rather than passed in, for the reason
   * {@link openKeyLink} states: nothing in this app opens a URL it was handed, and a notification
   * — a line of a file git union-merges across clones — is exactly the input that rule is for.
   */
  async openReleases(): Promise<PromptResult> {
    const open = this.deps.openExternal;
    if (!open) return { ok: false, message: 'This build cannot open a browser.' };
    await open(RELEASES_PAGE);
    return { ok: true, message: `Opened ${RELEASES_PAGE}.` };
  }

  /**
   * Whether {@link testKey} has anything to try, in its own sentence either way — so the Setup
   * pane's greyed-out button says why it is grey rather than looking broken.
   */
  async previewTestKey(vendor: keyof ResolvedKeys): Promise<PromptResult> {
    if (this.mock) {
      return { ok: false, message: 'Mock mode makes no calls, so there is nothing to test.' };
    }
    const entry = (await this.keyStatusView()).vendors.find((v) => v.vendor === vendor);
    if (!entry?.resolved) {
      return { ok: false, message: `No ${vendor} key resolves yet, so there is nothing to try.` };
    }
    return { ok: true, message: `One small ${vendor} call, with the key it already reads.` };
  }

  /**
   * Make one real, cheap call with a vendor's key and say whether it worked.
   *
   * The Setup pane exists to end the state of "I pasted something and I do not know". A key can
   * resolve and still be wrong — revoked, mistyped, or belonging to an account with no credit —
   * and every one of those failures otherwise surfaces much later, inside a run, as a stack of
   * pipeline errors that name a task rather than a key.
   *
   * The model is one the project already configures for that vendor, not a name written down
   * here: a model id this file invented could be one the account has no access to, and the
   * refusal would then be about our choice rather than about their key.
   */
  async testKey(vendor: keyof ResolvedKeys): Promise<PromptResult> {
    if (this.mock)
      return { ok: true, message: 'Mock mode makes no calls, so there is nothing to test.' };

    const config = await loadConfig(this.dir);
    const modelId = [config.models.text, ...config.models.vision].find(
      (id) => chatVendorFor(id) === vendor,
    );
    if (!modelId) {
      return {
        ok: false,
        message: `This project configures no ${vendor} chat model, so there is nothing cheap to call.`,
      };
    }

    try {
      const keys = await resolveKeys(config, {
        secretsDirs: await secretDirsFor(this.dir),
        require: [vendor],
      });
      const backend = chatBackendFor(modelId, keys).backend;
      await backend.message({ prompt: 'Reply with the single word OK.' });
      return { ok: true, message: `The ${vendor} key works — ${modelId} answered.` };
    } catch (err) {
      // The provider's own sentence, which is the one that distinguishes "no credit" from
      // "revoked" from "no access to that model". `resolveKeys` names sources, never values, and
      // a vendor SDK does not echo the key back, so this is safe to show.
      return { ok: false, message: `The ${vendor} key did not work: ${(err as Error).message}` };
    }
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
   * The two writers are the same two `setArtNotes` has — an entity sheet through `@vn/model`'s
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
   * Draw one concept image: a sentence in, an asset out, with no task node and no place in any
   * plan — the one path to an image the planner deliberately does not have. Providers come from
   * the session's own `mock` flag, so there is no second policy about whether this run makes
   * real art.
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
   * The rule behind both replace halves: the asset names its own slot, so an author replacing
   * the picture in front of them never types one. Refusals come from {@link adoptionForSlot}
   * asked about these very bytes — a portrait, a concept and an upload are refused there by
   * name. Both the preview and the act ask the same question, so the strip on screen and the
   * command it runs apply the same rule.
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

    // Apply every refusal except `MOCK_PLACEHOLDER`: that one judges the incoming bytes, and
    // the chooser has not produced any yet — `uploadOf` refuses mock art at the upload, which is
    // where that check belongs. This call only exists to check the slot itself.
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
   * Put an outside file in the place of a picture the project generated: upload it, then adopt
   * it onto the slot those bytes fill. It is a single act, so a file that lands but cannot be
   * adopted reports that in one answer — `uploadAsset` produces that message.
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
      boundGraphs: await this.boundGraphSlugs(),
    });
  }

  /**
   * Which graph draws each slot, for the tree rows the Gen Graph pane claims. This reads the
   * graph files and nothing else, so a tree read costs no journal replay and no services. A
   * graph that will not load is skipped silently, because `docTree` is called on every change
   * and the load path already files a notification naming it.
   */
  private async boundGraphSlugs(): Promise<Map<string, string>> {
    registerGenRuntimes();

    const git = openGit(this.dir);
    const loaded: { slug: string; graph: GenGraph }[] = [];
    for (const slug of await graphSlugs(this.dir)) {
      const read = await readGraph(this.dir, slug, git);
      if (read.ok) loaded.push({ slug, graph: read.graph });
    }

    const { bound } = bindSlots(loaded);
    return new Map([...bound].map(([slot, { entry }]) => [slot, entry.slug]));
  }

  /**
   * The project's skills, as the tree needs them — one `discoverSkills` per doc-tree read. Only
   * identity fields ship; the instruction body is dropped here rather than sent to the renderer
   * and ignored there.
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
   * Every file under `.aiagent/skills`, as the Skills pane's own tree — the content the document
   * tree deliberately leaves out.
   *
   * Its own walk rather than a filter over `fileTree()`: that one is capped at `TREE_MAX_FILES`
   * across the whole project, so on a large one `.aiagent` could be truncated away and this pane
   * would draw an empty directory with nothing to say about why. It would also ship the entire
   * project's file list to paint a dozen rows.
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
    return checkDocWrite(this.dir, path, text, seenHash, DOC_WRITERS);
  }

  /**
   * Save one document whole, and say what the model will make of it. The refusals are
   * `checkDocWrite`'s; the schema check is here because it needs `@vn/model`, which `@vn/store`
   * may not import — and because a failure there is a diagnostic beside a saved file rather than
   * a refusal, exactly the split `loadInputs` already draws.
   */
  async saveDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocSaveResult>> {
    const plan = await writeDocFile(this.dir, path, text, seenHash, DOC_WRITERS);
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
   * one place — a reader cannot tell whether a human or the agent made a file by looking at it.
   * The path is conventional; a sheet filed elsewhere gets there by being moved afterwards, not
   * by a different scaffolder.
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
    // A skill is a directory with a `SKILL.md` in it, and `writeFileAtomic` makes the directory.
    // The refusal differs from `writeSkill`'s deliberately: that one refuses an existing
    // directory, while this goes through `checkDocWrite` with an empty `seenHash` and refuses an
    // existing file. So a directory a human has already put a vetted `run.mjs` in accepts the
    // author's scaffold and rejects the agent's, and the human is the one who put the script there.
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

  /** Whether the scaffold would land — mostly a check that the name is not already taken. */
  async previewCreate(kind: NewDocKind, name: string): Promise<DocResult<DocWritePlan>> {
    const scaffold = this.newDoc(kind, name);
    if (!scaffold) return { ok: false, reason: `"${name}" does not name a ${kind}` };
    return checkDocWrite(this.dir, scaffold.path, scaffold.text, '', DOC_WRITERS);
  }

  /**
   * Scaffold a character, a location, a wiki note or a skill from a name. The empty `seenHash` is
   * what makes this a creation: the write refuses over a file already there rather than
   * overwriting whatever the author had under that name.
   */
  async createDoc(
    kind: NewDocKind,
    name: string,
  ): Promise<DocResult<DocSaveResult & { id: string }>> {
    const scaffold = this.newDoc(kind, name);
    if (!scaffold) return { ok: false, reason: `"${name}" does not name a ${kind}` };
    const written = await writeDocFile(this.dir, scaffold.path, scaffold.text, '', DOC_WRITERS);
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
   * Read a document and work out what renaming it to `name` would write. `renameInText` decides
   * where in the text the name lives; this is the half that touches the disk. Both the check and
   * the run go through it, so they ask the same question of the same bytes.
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
   * Rename one document in place. The file never moves: an id is derived from a name once, at
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
   * The decision behind `story.moveShot`, which is the one scene edit whose rule needs the
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
   * files and reports; what it buys is that a later insertion can no longer shift them.
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
   * aside. Shared with `previewImport`, so a refused check reports the same message the run
   * would.
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
    // Uses the same finder the loader uses to report a leftover screenplay, so the file this
    // converts is the file that warning names — not a second opinion about which one it is.
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
   * equivalent. The screenplay is moved aside rather than deleted, and moved last: while it is
   * still a `.fountain` the project reports it on every load, so the rename finishes the import.
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
      ...(loaded?.nextShot !== undefined ? { nextShot: loaded.nextShot } : {}),
    };
  }

  /**
   * Rewrite one shot's coverage. The rule is `@vn/scriptedit`'s `setCoverage`, so the timeline's mid-drag
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
   * What `story.setSceneOutfit` would do, decided without writing. It does not preview against
   * the story graph the other branch checks use: that projection carries edges and reachability,
   * and the outfit markers this rule needs are not in it.
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

  /** The variant rule against a fresh load, shared by the preview and the write. */
  private async shotVariantRule(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    const project = await loadProject(this.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

    const location = project.model.locations.get(scene.location);
    if (!location) {
      return {
        project,
        op: { ok: false, error: `No location "${scene.location}", which ${sceneId} is set in.` },
      };
    }
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
    return {
      project,
      op: setShotVariant(loaded.shots, scene, location, { shot: shotId, variant }),
    };
  }

  /** What `story.setVariant` would do, without writing it. */
  async previewShotVariant(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<ShotOutfitOp> {
    return (await this.shotVariantRule(sceneId, shotId, variant)).op;
  }

  /**
   * Set which variant of the scene's location one shot is drawn against. Like `setShotOutfit` this
   * changes the shot's prompt, so the shot re-hashes and the next run re-renders it. Shot fallout
   * does not apply: a variant change touches neither `coversLines` nor `proseHash`.
   */
  async setShotVariant(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.shotVariantRule(sceneId, shotId, variant);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok: true,
      message: op.message,
      written: [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.sceneCoverage(sceneId),
    };
  }

  /**
   * The new-shot rule against a fresh load, shared by the preview and the write. The scene's
   * location supplies the variant ids the default is validated against, the same way the model
   * decomposer's answer is.
   */
  private async newShotRule(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[],
  ): Promise<{ project: LoadedProject; op: NewShotOp }> {
    const project = await loadProject(this.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

    const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    const location = project.model.locations.get(scene.location);
    const op = planNewShot(scene, loaded, {
      lines,
      ...(framing ? { framing: framing as Shot['framing'] } : {}),
      subjects,
      variants: location?.variants.map((v) => v.id) ?? [],
      cast: [...project.model.characters.keys()],
    });
    return { project, op };
  }

  /** What `story.newShot` would do, without writing it. */
  async previewNewShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ): Promise<NewShotOp> {
    return (await this.newShotRule(sceneId, lines, framing, subjects)).op;
  }

  /**
   * Create a shot by hand — on an undecomposed scene, this writes the storyboard file itself,
   * which ends decomposition for the scene. This is the only writer that advances the `nextShot`
   * mark: the id it spends is retired by the same write.
   */
  async newShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.newShotRule(sceneId, lines, framing, subjects);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots, { nextShot: op.nextShot });
    return {
      ok: true,
      message: op.message,
      written: [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.sceneCoverage(sceneId),
    };
  }

  /** The delete-shot rule against a fresh load, shared by the preview and the write. */
  private async deleteShotRule(
    sceneId: string,
    shotId: string,
  ): Promise<{ project: LoadedProject; op: DeleteShotOp }> {
    const project = await loadProject(this.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

    const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    if (!loaded) {
      return {
        project,
        op: { ok: false, error: `Scene "${sceneId}" has no decomposition yet.` },
      };
    }
    return { project, op: planDeleteShot(loaded, { shot: shotId }) };
  }

  /** What `story.deleteShot` would do, without writing it. */
  async previewDeleteShot(sceneId: string, shotId: string): Promise<DeleteShotOp> {
    return (await this.deleteShotRule(sceneId, shotId)).op;
  }

  /**
   * Delete a shot. Removing the last one deletes the file itself — restoring the one signal that
   * means "decompose this scene" — and otherwise the rewrite carries the `nextShot` mark, so the
   * freed id stays retired.
   */
  async deleteShot(
    sceneId: string,
    shotId: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.deleteShotRule(sceneId, shotId);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    if (op.deleteFile) await deleteShots(project.paths, sceneId);
    else await writeShots(project.paths, sceneId, op.shots, { nextShot: op.nextShot });
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
   * What a run would find. The count is a dry run against mock providers — what `vngen cost`
   * does — rather than a read of the replayed graph: `tasks.jsonl` holds only what earlier runs
   * planned, so on a project that has never run it says zero while the work is not zero. Nothing
   * is written; a dry run plans with `readOnlyShots` and requeues in memory.
   *
   * The number is still a floor, because planning is incremental and a wave that unlocks later
   * work has not run. So it is reported, never refused — and the keys a real run needs are
   * checked separately, since a dry run needs none.
   */
  /**
   * Every graph the project holds, with its journal replayed and its blobs kept under its own
   * slug. A graph that will not load is left out and its problem reported, because a run that
   * quietly fell back to the fixed runners would draw a picture nobody asked for.
   */
  private async loadGraphs(
    project: LoadedProject,
    deps: GenDeps,
  ): Promise<{ loaded: LoadedGraphDoc[]; problems: string[] }> {
    registerGenRuntimes();

    const git = openGit(this.dir);
    const loaded: LoadedGraphDoc[] = [];
    const problems: string[] = [];

    for (const slug of await graphSlugs(this.dir)) {
      const read = await readGraph(this.dir, slug, git);
      if (!read.ok) {
        problems.push(read.reason);
        continue;
      }
      loaded.push({
        slug,
        graph: read.graph,
        journal: await readGraphJournal(project.paths, slug),
        services: createGenServices({
          model: project.model,
          store: project.store,
          providers: deps.providers,
          imageBackend: deps.imageBackend,
          blobs: graphBlobStore(project.paths, slug),
          ...(deps.keys === undefined ? {} : { keys: deps.keys }),
        }),
        record: (record: GraphJournalRecord) => appendGraphJournal(project.paths, slug, record),
      });
    }

    return { loaded, problems };
  }

  /**
   * The slot→graph index a run consults, or undefined when the project holds no graph to
   * consult. A graph that will not load and a slot two graphs claim are both filed as
   * notifications rather than thrown: the run still has the fixed runners to draw the rest of
   * the wave with, and refusing to start would cost the author that work.
   */
  private async graphRuntime(
    project: LoadedProject,
    deps: GenDeps,
  ): Promise<GraphRuntime | undefined> {
    const { loaded, problems } = await this.loadGraphs(project, deps);
    for (const problem of problems) {
      void notify({ category: 'error', level: 'warn', source: 'pipeline', message: problem });
    }
    if (loaded.length === 0) return undefined;

    const { runtime, conflicts } = indexGraphs(loaded);
    for (const slot of conflicts) {
      void notify({
        category: 'error',
        level: 'warn',
        source: 'pipeline',
        message: `More than one active output claims ${slot}, so no graph draws it.`,
      });
    }
    return runtime;
  }

  /**
   * One graph's document, for a renderer that cannot reach the file. The graph is serialized
   * back to the file's own layout rather than to the DSL, because the DSL carries no node
   * positions and the pane has to draw the graph where the author left it.
   */
  async graphDoc(slug: GraphSlug): Promise<GraphDocRead> {
    const read = await readGraph(this.dir, slug, openGit(this.dir));
    if (!read.ok) return { ok: false, reason: read.reason };
    return {
      ok: true,
      path: read.path,
      file: writeGraphFile(read.graph),
      diagnostics: read.diagnostics,
    };
  }

  /**
   * What one graph is expected to spend if it runs from nothing. The refine tail is counted
   * `max_refine_attempts` times, so the figure is the worst case rather than what a run that
   * passes first time costs.
   */
  async graphEstimate(slug: GraphSlug): Promise<
    | { ok: false; reason: string }
    | {
        ok: true;
        estimate: GenPricedEstimate;
        /** Set when the oldest table an estimate drew on is older than `PRICES_STALE_DAYS`. */
        stale: boolean;
      }
  > {
    const read = await readGraph(this.dir, slug, openGit(this.dir));
    if (!read.ok) return { ok: false, reason: read.reason };

    const { config } = await loadProject(this.dir);
    const counted = estimateGraph(read.graph, {
      maxRefineAttempts: config.max_refine_attempts,
    });
    const estimate = priceEstimate(counted.lines, await hostPriceTables());
    const asOf = estimate.pricesAsOf;
    return {
      ok: true,
      estimate,
      stale: asOf !== undefined && pricesAreStale(asOf, new Date()),
    };
  }

  /**
   * Runs a plugin's price agent and folds what it answers into the author's own table. The
   * caller has confirmed the spend, because the agent calls a model on the author's key.
   */
  async refreshPrices(
    plugin: string,
  ): Promise<{ ok: true; models: string[]; pricesAsOf: string } | { ok: false; reason: string }> {
    const project = await loadProject(this.dir);
    const deps = await buildGenDeps(project, false);
    const services = createGenServices({
      model: project.model,
      store: project.store,
      providers: deps.providers,
      imageBackend: deps.imageBackend,
      ...(deps.keys === undefined ? {} : { keys: deps.keys }),
    });

    const done = await refreshUserPrices(plugin, services, new Date());
    if (!done.ok) return done;
    return { ok: true, models: done.models, pricesAsOf: done.table.pricesAsOf };
  }

  /**
   * Run one graph interactively, through the executor and the journal the scheduler runs it
   * through. Nothing enters the asset store here: a picture becomes an asset only on the bound
   * path, where a task's slot names the graph that draws it. `force` invalidates every paid
   * ancestor of the target first, so re-running an unchanged graph is a request rather than a
   * resume that does nothing.
   */
  async runGraph(
    slug: GraphSlug,
    opts: { node?: string; force?: boolean; mock?: boolean } = {},
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const read = await readGraph(this.dir, slug, openGit(this.dir));
    if (!read.ok) return { ok: false, message: read.reason, written: [] };

    const target =
      opts.node === undefined ? activeOutputOf(read.graph) : nodeIdOf(read.graph, opts.node);
    if (target === undefined) {
      return {
        ok: false,
        message: `the ${slug} graph has no active output node, so there is nothing to run to`,
        written: [],
      };
    }
    if (read.graph.nodeIdMap.get(target) === undefined) {
      return { ok: false, message: `the ${slug} graph holds no node ${target}`, written: [] };
    }

    return this.while(BUSY_RUN, async () => {
      const project = await loadProject(this.dir);
      const deps = await buildGenDeps(project, opts.mock ?? false);
      const entry = (await this.loadGraphs(project, deps)).loaded.find((g) => g.slug === slug);
      if (entry === undefined) {
        return { ok: false, message: `the ${slug} graph could not be loaded`, written: [] };
      }

      const ctx: GenRunContext = {
        services: entry.services,
        journal: entry.journal,
        record: entry.record,
      };
      const result = await executeGenGraph(read.graph, ctx, {
        targets: [target],
        ...(opts.force === true ? { force: true } : {}),
      });

      const written = [relPath(this.dir, graphJournalFile(project.paths, slug))];
      const failure = result.failures[0];
      if (failure !== undefined) {
        return { ok: false, message: `node ${failure.nodeId} failed: ${failure.error}`, written };
      }
      const ran = result.ran.length;
      const skipped = result.skipped.length;
      return {
        ok: true,
        message:
          `Ran ${ran} node${ran === 1 ? '' : 's'} in ${slug}` +
          `${skipped === 0 ? '' : `, resuming ${skipped} from the journal`}.`,
        written,
      };
    });
  }

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
    const deps = await buildGenDeps(project, true);
    const graphs = await this.graphRuntime(project, deps);
    const summary = await runPipeline({
      model: project.model,
      graph: project.graph,
      store: project.store,
      providers: deps.providers,
      config: project.config,
      paths: project.paths,
      dryRun: true,
      now: () => new Date().toISOString(),
      ...(graphs === undefined ? {} : { graphs }),
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
   * What `decomposeAllScenes` would do, computed without calling the model. A `check` may not
   * spend a model call, so this is the cheap half: how many scenes have no storyboard, which
   * files will not parse, which scenes name a character the project does not have yet — and
   * whether the text key resolves.
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
    const outer = this.cancel;
    const cancel = outer ?? new AbortController();
    this.cancel = cancel;
    const { summary, assets } = await this.while(BUSY_RUN, async () => {
      const project = await loadProject(this.dir);
      const deps = await buildGenDeps(project, mock);
      const graphs = await this.graphRuntime(project, deps);
      const ran = await runPipeline({
        model: project.model,
        graph: project.graph,
        store: project.store,
        providers: deps.providers,
        config: project.config,
        paths: project.paths,
        dryRun: mock,
        now: () => new Date().toISOString(),
        signal: cancel.signal,
        ...(graphs === undefined ? {} : { graphs }),
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
      // A pass owns its controller for every round it still has to take, so only a run that made
      // its own clears it.
      if (!outer && this.cancel === cancel) this.cancel = undefined;
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
    // Named, because otherwise a picture the author did not ask for changes with no explanation
    const redrawn = summary.redrawn.length
      ? `, ${summary.redrawn.length} redrawn for an edited graph`
      : '';
    void notify({
      category: 'pipeline',
      level: summary.failed.length > 0 ? 'warn' : 'info',
      source: 'pipeline',
      message: `${how} ${ended}: ${ran} task${ran === 1 ? '' : 's'}, ${summary.failed.length} failed${redrawn}${gate}.`,
    });
  }
}
