/**
 * One workspace's worth of backend state, owned by the Electron main process. This is the
 * desktop app's join point: it embeds BOTH the authoring agent (`@vn/authoring`) and the
 * generative scheduler (`@vn/scheduler`) in-process and exposes them as plain async methods
 * the IPC layer can call. The glue mirrors `apps/authoring/src/agent.ts` (agent assembly)
 * and `apps/cli/src/project.ts` (project + provider construction); it is intentionally not
 * imported from those apps, which aren't libraries.
 */
import {
  keysPresent,
  loadConfig,
  resolveKeys,
  secretDirsFor,
  userKeysDir,
  type ProjectConfig,
  type ResolvedKeys,
  type VendorKeyStatus,
} from '@vn/config';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { openGit } from '@vn/git';
import { ConfigError } from '@vn/util';
import {
  characterFromDoc,
  locationFromDoc,
  modelFromInputs,
  variantEntries,
  wardrobeEntries,
  type CharacterEdit,
  type LocationEdit,
} from '@vn/model';
import { type FrontMatterDoc, type LoadedInputs } from '@vn/parse';
import {
  AssetStore,
  ProjectPaths,
  conventionalKind,
  docKind,
  loadInputs,
  readShots,
  type DocFile,
  type DocResult,
  type DocWritePlan,
  type GuardedWriters,
} from '@vn/store';
import {
  activeOutputs,
  estimateSentence,
  type GenPricedEstimate,
  type Graph as GenGraph,
  type GraphId,
} from '@vn/gengraph';
import { readModelCatalog } from '@vn/gengraph/state';

import { loadGraph, type TaskGraph } from '@vn/taskgraph';
import { driftOf, repairAccepted, type DecomposeAllResult, type LoadedGraph } from '@vn/pipeline';
import { suspensionMap, type PromptRung, type Suspension } from '@vn/artgen';
import {
  chatBackendFor,
  chatRoute,
  chatVendorFor,
  createImageBackend,
  createMockProviders,
  createProviders,
  projectModels,
  resolveRoutes,
  StubImageBackend,
  type FetchImpl,
  type ImageBackend,
} from '@vn/providers';
import {
  API_RETRIES,
  Agent,
  NativeAgentBackend,
  StructuredAgentBackend,
  Workspace,
  apiRecoveryQuestion,
  composeSystem,
  createRegistry,
  historyTools,
  loadContext,
  readApiPlan,
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
  type SystemSection,
  type Tool,
  type ToolContext,
  type UploadBatch,
  type WorkspaceIndex,
} from '@vn/authoring';
import type { Excerpt } from '@vn/bible';
import {
  type BranchOp,
  type DeleteShotOp,
  type LineOp,
  type NewShotOp,
  type SceneOutfitOp,
  type ScriptState,
  type SheetsOp,
  type ShotOutfitOp,
} from '@vn/scriptedit';
import { sourcesOf, type SceneEditInput, type SceneSource } from '@vn/scriptedit/write';
import type {
  AssetKind,
  EffortChoice,
  Lettering,
  ShotForm,
  LocationVariant,
  Outfit,
  PagePanel,
  PanelBubble,
  Playable,
  ProjectModel,
  PromptOverride,
  Providers,
  Scene,
  Shot,
} from '@vn/types';
import {
  DEFAULT_BUDGET,
  DEFAULT_AGENT_EFFORT,
  TEXT_MODELS,
  chatRouteFor,
  type BudgetChoice,
  type Route,
  type TaskKind,
  type Transport,
} from '@vn/types';
import { type Analyst, type AnalystGrant, type Redactor, type Report } from '@vn/agentreport';
import { BUSY_AGENT, BUSY_PASS, BUSY_REPORT, busyName } from '../../shared/ipc.js';
import type {
  AgentSystem,
  ApproveResult,
  AssetInfo,
  AssetListing,
  BranchEditResult,
  BusyProgress,
  DocNode,
  DocSaveResult,
  DocTree,
  GateCandidate,
  GraphDocRead,
  GroupDocRead,
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
} from '../../shared/ipc.js';
import { type GuideUrlField, type KeyGuide } from '../../shared/apikeys.js';
import { type ApprovalQueue } from '../workspace/approvals.js';
import { type GraphSlug } from '../doctree/graphs.js';
import { notify } from '../notify/notifications.js';
import { builtinSkillsDir } from '../distribution/resources.js';
import { type UpdateCheck } from '../distribution/updates.js';
import { labelContext } from '../assets/assetlabel.js';
import { type SkillEntry } from '../doctree/doctree.js';
import { confirmDetail } from '../agent/toolconfirm.js';
import { showMeTool } from '../agent/showme.js';
import { createDesktopInteractions } from '../../shared/interactions.js';
import { createDesktopRegistry } from '../commands/index.js';
import type { Tour } from '../../shared/tours.js';
import {
  answeredQuestion,
  decided,
  emptyConvo,
  proposed,
  queried,
  received,
  type CompactionMark,
  type Convo,
  type ThreadUsage,
} from '../../shared/convo.js';
import {
  NATIVE_VERSION,
  appendItem,
  appendNative,
  appendUsage,
  readNative,
  type NativeLine,
  type ThreadHeader,
  type ThreadRecord,
} from '../notify/threads.js';
import {
  TRANSPORTS,
  continuingTransport,
  narrowedTo,
  type OpenedThread,
} from '../../shared/threads.js';
import type { PromptView } from '../../shared/prompt.js';
import { type AnalysisParts, type AnalysisRequest, type Transcript } from '../agent/agentreport.js';

/** A backend that does no LLM work — lets the app run offline (mirrors the REPL's --mock). */
export class MockAgentBackend implements AgentBackend {
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
  pushBusy(state: { what?: string } & BusyProgress): void;
  /**
   * Offer to diagnose the call that just failed. Pushed for the same reason `pushBusy` is: the
   * author is answering a card that is still open inside a running turn, and there is no command
   * outcome to hang it on.
   */
  offerDiagnosis?(fault: { thread?: string; message: string }): void;
  /**
   * Walk the author through a tour the agent wrote. Pushed for the same reason {@link pushBusy}
   * is: the agent is still mid-turn and there is no command outcome to hang an effect on. Absent
   * where there is no window, and `show_me` then refuses rather than claim it showed anything.
   */
  showTour?(tour: Tour): void;
}

/** A loaded project: config, paths, validated model, persisted store + task graph. */
export interface LoadedProject {
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
export const editInputOf = (project: LoadedProject): SceneEditInput => ({
  paths  : project.paths,
  sources: project.sources,
  ...(project.config.start === undefined ? {} : { entry: project.config.start }),
});

/**
 * The task kinds that render a picture. Each one's prompt opens with the project's art style, so
 * this is exactly the set of tasks a style change re-keys. `vision_review` and `prompt_refine`
 * read a prompt but never carry the style preamble.
 */
export const IMAGE_KINDS = new Set<TaskKind>([
  'location_ref',
  'portrait',
  'model_sheet',
  'outfit_sheet',
  'shot_image',
]);

/** Workspace-relative and forward-slashed, which is what a `written` list reports. */
export function relPath(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}

/**
 * The kinds `previewAccept` does not refuse outright. The excluded kinds have no approval to
 * grant or withhold: a portrait is approved through the character gate, a concept is consumed by
 * nothing, and an upload was never generated in the first place.
 */
export const ACCEPTABLE = new Set<AssetKind>([
  'location_ref',
  'model_sheet',
  'outfit_sheet',
  'shot_image',
]);

/**
 * Which assets are suspended, keyed by hash. One walk answers both the listing and the one-asset
 * question, so a pane and `asset.suspended` can never disagree about a reason.
 */
export function suspensionsOf(
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
 * The frames whose scene has moved on since they were drawn. Re-derived on every call, like every
 * other reading of drift, and the same walk `doctree.ts` makes for the Stale branch — so what the
 * tree files as stale and what the approval queue leaves out cannot disagree.
 */
export function driftedFrames(model: ProjectModel, shots: Map<string, Shot[] | null>): Set<string> {
  const out = new Set<string>();
  for (const scene of model.scenes.values()) {
    for (const shot of shots.get(scene.id) ?? []) {
      if (shot.image !== undefined && driftOf(scene, shot) === 'drifted') out.add(shot.image);
    }
  }
  return out;
}

/**
 * Every scene's persisted storyboard, by scene id. A storyboard that will not parse is one
 * scene's problem. With `reportBroken` it becomes a `null` the tree draws a badge for. Without
 * that option the scene is simply absent, which is what every other reader wants.
 */
export async function readAllShots(
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
export function withOutfit(outfit: Outfit, patch: Partial<Outfit>): Outfit {
  const next = { ...outfit, ...patch };
  if (!next.artNotes) delete next.artNotes;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/** The same for a variant. */
export function withVariant(
  variant: LocationVariant,
  patch: Partial<LocationVariant>,
): LocationVariant {
  const next = { ...variant, ...patch };
  if (!next.artNotes) delete next.artNotes;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/** A shot with its prompt override set, or removed when the edit settled on nothing. */
export function withPromptOverride(shot: Shot, override: PromptOverride | undefined): Shot {
  const { promptOverride: _drop, ...rest } = shot;
  return override ? { ...rest, promptOverride: override } : rest;
}

/**
 * The character edit that applies one rung's prompt override. Clearing an override must be
 * stated explicitly: an empty override object is what `overrideData` serializes as a removed
 * key, so `undefined` here still produces an edit.
 */
export function characterOverrideEdit(
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
export function locationOverrideEdit(
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
export function frozenReason(kind: AssetKind): string {
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
export function leakSentence(leaked: readonly string[]): string {
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
export const TREE_SKIP = new Set(['.git', 'node_modules', '.vnstudio']);
export const TREE_MAX_FILES = 5000;

/** The command namespaces that own the guarded directories, named in a whole-file save's refusal. */
export const DOC_WRITERS: GuardedWriters = { scenes: 'story.*', graphs: 'gengraph.*' };

/** The four things `doc.create` scaffolds. A note is a title and nothing else. */
export type NewDocKind = 'character' | 'location' | 'note' | 'skill';

/**
 * What the model will make of a document that has already been saved — a diagnostic sentence, or
 * nothing. The kind comes from `docKind`, the rule entity discovery uses, so a tag that disagrees
 * with the directory is reported as the conflict discovery would raise rather than validated as
 * either kind. A note is not checked.
 */
export function entityDiagnostic(path: string, doc: FrontMatterDoc): string | undefined {
  const kind = docKind(conventionalKind(path), doc.data);
  if (kind.kind === 'note') return undefined;
  if (kind.kind === 'conflict') return `${path} ${kind.reason}`;
  const res = kind.kind === 'character' ? characterFromDoc(doc) : locationFromDoc(doc);
  return res.ok ? undefined : res.diagnostic.message;
}

/** The four directories the project map is derived from — a write to any of them makes it stale. */
export const MAPPED_DIRS = ['characters/', 'locations/', 'scenes/', 'wiki/'];

/** Whether a finished turn wrote anything the project map is built out of. */
export function wroteAuthoredInput(events: readonly AgentEvent[]): boolean {
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
export function resumedNote(header: ThreadHeader): AgentMessage {
  const archived = header.archived?.[header.archived.length - 1];
  const saved = archived ? ` It was last saved into git at ${archived.commit.slice(0, 8)}.` : '';
  return {
    role   : 'context',
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
export async function walkFiles(dir: string): Promise<string[]> {
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

export async function loadProject(dir: string): Promise<LoadedProject> {
  const config = await loadConfig(dir);
  const paths = new ProjectPaths(dir);
  const inputs = await loadInputs(paths);
  const model = modelFromInputs(inputs, { title: config.title, start: config.start });
  const store = await AssetStore.open(paths);
  const graph = await loadGraph(paths);
  const project: LoadedProject = {
    dir,
    config,
    paths,
    model,
    store,
    graph,
    sources: sourcesOf(inputs),
    inputs,
  };
  // A slot holding two accepted takes resolves to nothing, so every surface reading this
  // project would show it as unrendered; the manifest is put right as it is read
  await repairAccepted({ model, store, graph, readShots: () => readAllShots(project) });
  return project;
}

/** One loaded graph, keyed by the slug its document and its journal are both filed under. */
export interface LoadedGraphDoc extends LoadedGraph {
  slug: GraphSlug;
}

/** What one file looked like when something was recorded about it. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * One document's last answer, and what every file it was built from looked like at the time: its
 * own, and the definition file of each group it resolved. A file that was absent is held as
 * undefined, so its arrival reads as a change too.
 */
export interface HeldDoc<R> {
  read: R;
  stamps: Map<string, FileStamp | undefined>;
}

/** The stamp for `file`, or undefined when there is nothing there to stamp. */
export async function statOf(file: string): Promise<FileStamp | undefined> {
  const found = await stat(file).catch(() => null);
  return found ? { mtimeMs: found.mtimeMs, size: found.size } : undefined;
}

export async function stampsOf(
  files: readonly string[],
): Promise<Map<string, FileStamp | undefined>> {
  const out = new Map<string, FileStamp | undefined>();
  for (const file of files) out.set(file, await statOf(file));
  return out;
}

/** True while every file a held answer was built from still looks the way it did. */
export async function unmoved(held: HeldDoc<unknown>): Promise<boolean> {
  for (const [file, was] of held.stamps) {
    const now = await statOf(file);
    if (was?.mtimeMs !== now?.mtimeMs || was?.size !== now?.size) return false;
  }
  return true;
}

/** The output node a run targets when none is named, which is the first one still active. */
export function activeOutputOf(graph: GenGraph): GraphId | undefined {
  return activeOutputs(graph)[0]?.id;
}

/** What a run reaches the outside world through, whether it runs tasks or a generation graph. */
export interface GenDeps {
  providers: Providers;
  /** The byte-level seam a graph's image nodes call, beneath the provider the runners use. */
  imageBackend: ImageBackend;
  /** Absent under `mock`, where nothing is resolved and no vendor is reached. */
  keys?: ResolvedKeys;
}

export async function buildGenDeps(project: LoadedProject, mock: boolean): Promise<GenDeps> {
  const loadRef = async (ref: { hash: string; ext: string }) => ({
    bytes: await project.store.read(ref),
    ext  : ref.ext,
  });
  if (mock) {
    const imageBackend = new StubImageBackend();
    return { providers: createMockProviders({ refLoader: loadRef, imageBackend }), imageBackend };
  }
  // Every configured model is routed up front, so a run is refused here rather than failing
  // at its first review call after it has paid for a picture
  const keys = await resolveKeys(project.config, { secretsDirs: await secretDirsFor(project.dir) });
  resolveRoutes(project.config, keys, projectModels(project.config));
  // The cached listing says which OpenRouter models take a seed, so the router refuses one by
  // name rather than sending it
  const catalog = (await readModelCatalog())?.openrouter ?? [];
  return {
    providers   : createProviders({ config: project.config, keys, loadRef, catalog }),
    imageBackend: createImageBackend(project.config, keys, { catalog }),
    keys,
  };
}

export async function buildProviders(project: LoadedProject, mock: boolean): Promise<Providers> {
  return (await buildGenDeps(project, mock)).providers;
}

/** Backend state for a single workspace, addressed by the IPC handlers in `index.ts`. */
import { AgentPart } from './agent.js';
import { ReportPart } from './report.js';
import { GatePart } from './gate.js';
import { AssetPart } from './asset.js';
import { PromptPart } from './prompt.js';
import { ProjectPart } from './project.js';
import { DocsPart } from './docs.js';
import { StoryPart } from './story.js';
import { PipelinePart } from './pipeline.js';
import { GengraphPart, type SheetScaffoldPlan } from './gengraph.js';

export class WorkspaceSession {
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

  readonly agentPart: AgentPart = new AgentPart(this);
  readonly reportPart: ReportPart = new ReportPart(this);
  readonly gatePart: GatePart = new GatePart(this);
  readonly assetPart: AssetPart = new AssetPart(this);
  readonly promptPart: PromptPart = new PromptPart(this);
  readonly projectPart: ProjectPart = new ProjectPart(this);
  readonly docsPart: DocsPart = new DocsPart(this);
  readonly storyPart: StoryPart = new StoryPart(this);
  readonly pipelinePart: PipelinePart = new PipelinePart(this);
  readonly gengraphPart: GengraphPart = new GengraphPart(this);

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
   * Ask the generative work in flight to stop. It stops at a task boundary, so this returns what
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
    this.native.kind = backend.kind;
    return backend;
  }

  async chooseBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    if (this.mock) return new MockAgentBackend();
    const modelId = model ?? config.models.text;
    const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(this.dir) });
    const pin = this.native.opened ? this.native.transport : undefined;
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
    this.native.transport = route.transport;
    const chat = chatBackendFor(route, keys, this.effort).backend;
    return chat.chatConversation ? new NativeAgentBackend(chat) : new StructuredAgentBackend(chat);
  }

  /** What a resume binding is checked against: see {@link continuingTransport}. */
  async continuingTransport(
    config: ProjectConfig,
    recorded: Transport | undefined,
  ): Promise<Transport | undefined> {
    if (this.mock || this.model === '') return undefined;
    const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(this.dir) });
    return continuingTransport(this.model, keysPresent(keys), recorded);
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
        const id = this.thread?.id;
        if (!id) return [];
        const log = await readNative(new ProjectPaths(this.dir), id).catch(() => undefined);
        return log?.messages ?? [];
      },
    };
  }

  async ensureAgent(): Promise<Agent> {
    if (this.agent) return this.agent;
    const workspace = new Workspace(this.dir);
    const builtin = builtinSkillsDir();
    const ctx: ToolContext = {
      workspace,
      ...(builtin ? { builtinSkillsDir: builtin } : {}),
      git     : openGit(this.dir),
      // The agent's `generate_image` and the palette's `art.generate` draw the same picture; the
      // session's own `mock` is the only policy about whether it is real art.
      art     : workspaceArtGen(workspace, { mock: this.mock }),
      text    : workspaceTextLLM(workspace, { mock: this.mock }),
      // Approval is authorized by the author's own words, so this seam carries the model that
      // reads them alongside the two acts it gates.
      approval: {
        list     : () => this.approvable(),
        approve  : (item) => this.approveOne(item),
        approved : () => this.approvedAssets(),
        unapprove: (item) => this.unapproveOne(item),
        triage   : () => this.gatePart.triageBackend(),
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
        run     : (slug, opts) => this.runGraph(slug, { force: opts.force, mock: this.mock }),
      },
    };
    const context = await loadContext(this.dir);
    const config = await loadConfig(this.dir);
    this.model = config.models.text;
    this.agent = new Agent({
      backend: await this.buildBackend(config),
      ctx,
      registry: createRegistry([
        ...historyTools(this.history()),
        showMeTool({
          ...(this.deps.showTour ? { show: this.deps.showTour.bind(this.deps) } : {}),
          commands    : createDesktopRegistry(),
          interactions: createDesktopInteractions(),
        }) as Tool,
      ]),
      permission: this.permission(),
      system    : composeSystem(context),
      budget    : this.budget,
      onEvent: (event) => {
        this.record((convo) => received(convo, event));
        if (event.type === 'usage') this.recordUsage(event);
        this.deps.emitEvent(event);
        if (event.type === 'api') this.announceApi(event);
      },
      onApiError: (failure) => this.recoverApi(failure),
      onMessage : (message) => this.recordMessage(message),
    });
    return this.agent;
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

  // ---- IPC-facing methods ----

  index(): Promise<WorkspaceIndex> {
    return this.workspace().index();
  }

  /** The session's one workspace. See {@link heldWorkspace} for what it does and does not reuse. */

  workspace(): Workspace {
    return (this.heldWorkspace ??= new Workspace(this.dir));
  }

  /** Where the agent's generated project map lives, and whether it is ours to replace. */

  generatedContext(): Promise<GeneratedContextState> {
    return this.agentPart.generatedContext();
  }

  writeGeneratedContext(): Promise<{ file: string; counts: GeneratedCounts }> {
    return this.agentPart.writeGeneratedContext();
  }

  /**
   * Ranked passages from the story bible. The index survives between searches on the session's
   * one workspace, and `query` re-walks, so a passage written since the last search is still
   * found.
   */
  async searchBible(query: string, limit?: number): Promise<Excerpt[]> {
    return this.agentPart.searchBible(query, limit);
  }

  /**
   * One turn. `scene` is what the author had on screen when they hit send — resolved here against
   * the project rather than trusted, so a selection that has since been deleted contributes
   * nothing instead of a sentence about a scene that is gone.
   */
  async runAgent(input: string, scene?: string): Promise<RunResult> {
    return this.agentPart.runAgent(input, scene);
  }

  async setMode(mode: AgentMode): Promise<AgentMode> {
    return this.agentPart.setMode(mode);
  }

  /**
   * Hot-swap the text model and rebuild the backend, preserving conversation state. The bound
   * effort is stepped down to what the new model offers — `xhigh` is not a level Sonnet 4.6
   * takes — so nothing downstream shows a setting the wire will not carry.
   */
  async setModel(modelId: string): Promise<string> {
    return this.agentPart.setModel(modelId);
  }

  /**
   * Hot-swaps the reasoning setting the same way. A model that honours none keeps the setting
   * anyway. A surface greys itself out based on `supportsEffort`, and the backend simply omits
   * the knob, so switching back to a model that does honour it needs no second gesture.
   */
  async setEffort(effort: EffortChoice): Promise<EffortChoice> {
    return this.agentPart.setEffort(effort);
  }

  /**
   * The turn ceiling. Nothing is rebuilt and nothing is awaited beyond the agent existing: the
   * budget is read by the loop at each step, so a change lands on the turn in flight too.
   */
  async setBudget(budget: BudgetChoice): Promise<BudgetChoice> {
    return this.agentPart.setBudget(budget);
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
    return this.agentPart.systemPrompt();
  }

  /**
   * Start over. The thread is closed rather than deleted — a conversation that happened stays on
   * disk, and the next turn opens a new one — and it is committed on the way out, so that what
   * stays on disk also stays in history.
   */
  async clearAgent(): Promise<void> {
    return this.agentPart.clearAgent();
  }

  /**
   * Copy the author's own documents into `archive/`, verbatim. The rule lives in `@vn/authoring`
   * so the REPL's `/upload` and this land in the same place; the session only supplies the root.
   */
  async uploadFiles(files: string[]): Promise<UploadBatch> {
    return this.agentPart.uploadFiles(files);
  }

  async threads(): Promise<{ threads: ThreadHeader[]; active?: string }> {
    return this.agentPart.threads();
  }

  /**
   * A saved conversation, for reading. It ends the live one: the model is never shown what comes
   * back, so leaving the previous turns in its context while the screen shows another
   * conversation would leave the author and the agent talking about different things.
   */
  async openThreadForReading(id: string): Promise<OpenedThread> {
    return this.agentPart.openThreadForReading(id);
  }

  /**
   * Why thread `id` cannot be continued on the binding in force, or `undefined`. What
   * `agent.resumeThread` refuses with, and what its menu entry is greyed with.
   *
   * The agent is built first because building the backend is what settles which protocol it speaks
   * and which model it is bound to, and both are what the stored conversation is checked against.
   */
  async resumeRefusalFor(id: string): Promise<string | undefined> {
    return this.agentPart.resumeRefusalFor(id);
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
    return this.agentPart.resumeThread(id);
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
    return this.agentPart.compactRefusalFor();
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
    return this.agentPart.compactThread();
  }

  async renameThread(id: string, title: string): Promise<ThreadHeader> {
    return this.agentPart.renameThread(id, title);
  }

  /**
   * What `report.agent` would do, without spending anything on it. Every refusal is a sentence a
   * disabled control shows verbatim, and the key one is keyed to the chosen model — switching
   * the dropdown from a Claude id to a Gemini one changes which key has to be there. It names the
   * vendor and the command that sets it, never a value.
   */
  async previewReport(ask: ReportAsk): Promise<PromptResult> {
    return this.reportPart.previewReport(ask);
  }

  /**
   * Analyse a conversation that went wrong. Long — a minute or two, more with the source — so it
   * takes the busy flag every other long act does, and the dialog closes rather than being held
   * open across it.
   */
  async reportAgent(ask: ReportAsk): Promise<ReportDraft> {
    return this.reportPart.reportAgent(ask);
  }

  /**
   * Start a debug conversation about one thread and run its opening turn. Whatever was open is
   * dropped: there is one analyst per app instance, so every window that opens the pane follows
   * the same transcript rather than starting a second analysis of the same thread.
   */
  async openReport(ask: ReportAsk): Promise<ReportStateView> {
    return this.reportPart.openReport(ask);
  }

  async sayToReport(text: string): Promise<ReportStateView> {
    return this.reportPart.sayToReport(text);
  }

  /**
   * What granting one kind of access would do, without doing it. Each refusal is a sentence a
   * ticked-and-disabled box shows verbatim. The requests are counted off the snapshot the analysis
   * froze rather than off the live ring, because that is what a grant would actually hand over.
   */
  async previewGrant(kind: AnalystGrant['kind']): Promise<PromptResult> {
    return this.reportPart.previewGrant(kind);
  }

  /**
   * Give the open conversation more to read. The tools are advertised from the next turn, so this
   * is accepted while a turn is in flight and lands behind it.
   */
  async grantReport(kind: AnalystGrant['kind']): Promise<ReportStateView> {
    return this.reportPart.grantReport(kind);
  }

  /**
   * The conversation as main holds it. A pane that mounts part way through asks for this and
   * reduces the rows the way it reduces live events, so there is one reducer rather than a second
   * read path that can disagree with it.
   */
  reportState(): ReportStateView {
    return this.reportPart.reportState();
  }

  /**
   * What `report.openIssue` would do. Refuses if the leak scan finds any name the redactor knows
   * still in the body — that name would otherwise end up in a public issue tracker — and the
   * refusal message names it so the author can find it rather than hunt for it.
   */
  async previewIssue(input: { title: string; body: string }): Promise<PromptResult> {
    return this.reportPart.previewIssue(input);
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
    return this.reportPart.openIssue(input);
  }

  /**
   * Put `text` on the system clipboard. Throws where the build has no clipboard, so a caller
   * reports the failure rather than claiming a copy that never happened.
   */
  copyText(text: string): void {
    return this.reportPart.copyText(text);
  }

  async gateCandidates(characterId: string): Promise<GateCandidate[]> {
    return this.gatePart.gateCandidates(characterId);
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
    return this.gatePart.gateCandidacy(characterId, hash);
  }

  async approveCharacter(characterId: string, hash: string): Promise<ApproveResult> {
    return this.gatePart.approveCharacter(characterId, hash);
  }

  /**
   * Every picture that could be approved right now, upstream first — the same walk the document
   * tree's “Awaiting approval” group is a projection of, so the agent and the tree can never
   * disagree about what is waiting. A blocked row is still listed, with a sentence saying what
   * it is waiting on: the whole frontier is more useful than just the subset that happens to be
   * actionable this second.
   */
  async approvable(): Promise<Approvable[]> {
    return this.gatePart.approvable();
  }

  /**
   * Every picture that is approved right now, downstream first — the reverse of {@link approvable}
   * in both the filter and the order, because taking approval back has to run the other way: a
   * frame stops being accepted before the plate it was drawn from does.
   */
  async approvedAssets(): Promise<Approvable[]> {
    return this.gatePart.approvedAssets();
  }

  /**
   * The same list, ordered for reading rather than for approving: whatever `previousOrder` has
   * not seen goes on top. The caller owns `previousOrder` because it outlives the session — it is
   * persisted per project, so the list survives a restart.
   */
  async approvalQueue(previousOrder: readonly string[]): Promise<ApprovalQueue> {
    return this.gatePart.approvalQueue(previousOrder);
  }

  async approveOne(item: Approvable): Promise<{ ok: boolean; message: string }> {
    return this.gatePart.approveOne(item);
  }

  async unapproveOne(item: Approvable): Promise<{ ok: boolean; message: string }> {
    return this.gatePart.unapproveOne(item);
  }

  /**
   * Every suspended asset, upstream first, with the reason for each. Derived on every call:
   * suspension is a walk over the manifest and the rungs, never a stored flag
   * (`docs/plans/archive/INDEX.md#chunked-prompts` §13).
   */
  async suspensions(): Promise<Suspension[]> {
    return this.gatePart.suspensions();
  }

  /**
   * Every asset in the manifest, named the way the document tree names them. One label pass over
   * the whole manifest rather than the per-asset resolution `assetInfo` does, because the caller
   * is a picker showing all of them at once.
   */
  async assetLibrary(): Promise<AssetListing[]> {
    return this.assetPart.assetLibrary();
  }

  /**
   * Everything the asset editor draws for one asset: what the bytes are, the prompt they were
   * made from, the prompt the builders would write now, and the art-notes rungs that reach it.
   * `null` when the manifest has never heard of the hash.
   */
  async assetInfo(hash: string): Promise<AssetInfo | null> {
    return this.assetPart.assetInfo(hash);
  }

  /**
   * Whether accepting this asset is a question worth answering. Three kinds are refused by name:
   * a portrait, because approving one also writes `character.md` and `approved.png` and that is
   * `gate.approve`; a concept, because nothing downstream consumes one, so `accepted` would
   * mean nothing; and a reference, because nothing generated it — it counts by being pointed at.
   * Already accepted is not a refusal — re-accepting is how an author changes their mind.
   */
  async previewAccept(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewAccept(hash);
  }

  /**
   * Mark an asset as the accepted one for what it satisfies. Generic across both roots, and it
   * asks {@link previewAccept} itself rather than trusting that a check already ran — a caller
   * may skip the check, so the command cannot rely on it having happened.
   *
   * Accepting is exclusive per slot: the takes this one replaces are un-accepted in the same write,
   * because a slot with two accepted candidates cannot be resolved and reads as empty.
   */
  async acceptAsset(hash: string): Promise<PromptWriteResult> {
    return this.assetPart.acceptAsset(hash);
  }

  /**
   * Answers whether taking approval back off this asset is worth doing. A concept and a reference
   * are refused by name, for the reason {@link previewAccept} refuses them, since neither is ever
   * approved and there is nothing to take back. An asset that is not the accepted one is refused
   * too, since un-approving is about the answer a slot has rather than about a losing take.
   *
   * A portrait goes through the P3 gate, so its sentence says what else comes back out with it.
   */
  async previewUnapprove(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewUnapprove(hash);
  }

  /**
   * Take approval back off an asset: the manifest flag for an ordinary one, and for a portrait
   * the whole P3 gate — the sheet's `status:` and `approved_portrait:`, and `approved.png`.
   *
   * Asks {@link previewUnapprove} itself for the reason {@link acceptAsset} asks its own preview:
   * a caller may skip the check, so the write cannot rely on one having run.
   *
   * The bytes are never touched. Everything drawn from what this un-approves keeps its own
   * approval, and the slot graph reports it as blocked again until something answers the slot.
   */
  async unapproveAsset(hash: string): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.unapproveAsset(hash);
  }

  async previewRegenerate(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewRegenerate(hash);
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
  ): Promise<{ ok: boolean; message: string; written: string[]; task?: string }> {
    return this.assetPart.regenerateAsset(hash);
  }

  /** What `pipeline.draw` would do, without doing it. */
  async previewDraw(slot: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewDraw(slot);
  }

  /** Requeue one slot's task where it has run, and answer the task hash a targeted run takes. */
  async drawSlot(
    slot: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; task?: string }> {
    return this.assetPart.drawSlot(slot);
  }

  async previewArtNotes(target: string, notes: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewArtNotes(target, notes);
  }

  /**
   * Write one art-notes rung, through the rule `vnauthor`'s `set_art_notes` runs — an entity rung
   * into the sheet the model was built from, a shot rung into `work/shots/<sceneId>.json`.
   */
  async setArtNotes(
    target: string,
    notes: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.setArtNotes(target, notes);
  }

  async previewArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewArtSeed(target, seed);
  }

  async setArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.setArtSeed(target, seed);
  }

  async previewArtModel(target: string, model: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewArtModel(target, model);
  }

  async setArtModel(
    target: string,
    model: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.setArtModel(target, model);
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
    return this.promptPart.promptView(hash);
  }

  previewPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptResult> {
    return this.promptPart.previewPromptChunk(hash, chunk, op, text);
  }

  setPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptWriteResult> {
    return this.promptPart.setPromptChunk(hash, chunk, op, text);
  }

  previewMoveChunk(hash: string, chunk: string, after: string): Promise<PromptResult> {
    return this.promptPart.previewMoveChunk(hash, chunk, after);
  }

  movePromptChunk(hash: string, chunk: string, after: string): Promise<PromptWriteResult> {
    return this.promptPart.movePromptChunk(hash, chunk, after);
  }

  previewCustomPrompt(hash: string, text: string): Promise<PromptResult> {
    return this.promptPart.previewCustomPrompt(hash, text);
  }

  setCustomPrompt(hash: string, text: string): Promise<PromptWriteResult> {
    return this.promptPart.setCustomPrompt(hash, text);
  }

  previewClearPrompt(hash: string, part: ClearPart): Promise<PromptResult> {
    return this.promptPart.previewClearPrompt(hash, part);
  }

  clearPrompt(hash: string, part: ClearPart): Promise<PromptWriteResult> {
    return this.promptPart.clearPrompt(hash, part);
  }

  async previewAddRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    return this.promptPart.previewAddRef(hash, chunk, ref);
  }

  async addPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    return this.promptPart.addPromptRef(hash, chunk, ref);
  }

  previewDropRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    return this.promptPart.previewDropRef(hash, chunk, ref);
  }

  dropPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    return this.promptPart.dropPromptRef(hash, chunk, ref);
  }

  async previewRepin(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<PromptResult> {
    return this.promptPart.previewRepin(hash, chunk, ref, regenerate);
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
    return this.promptPart.repinPrompt(hash, chunk, ref, regenerate);
  }

  /**
   * What `prompt.condense` would spend the call on. It cannot know what the model will write, so
   * this answers the two questions that do not need it: is there anything to condense, and is
   * there a hand-written prompt in the way.
   */
  async previewCondense(hash: string, force: boolean): Promise<PromptResult> {
    return this.promptPart.previewCondense(hash, force);
  }

  /**
   * Condense the chunks into one prompt and store it at the rung. The condensation is held the
   * moment the chunks move under it — `composePrompt` keeps sending this text rather than the
   * fresh chunks, because re-rendering would move the task hash and re-render the picture.
   */
  async condenseAssetPrompt(hash: string, force: boolean): Promise<PromptWriteResult> {
    return this.promptPart.condenseAssetPrompt(hash, force);
  }

  /**
   * Which chunks the effective prompt still appears to say — `prompt.check`, and the same answer
   * the pane's marks come from. A read, so it never refuses over mode: in chunks mode nothing can
   * be missing, which is itself worth being able to ask.
   */
  async checkPrompt(hash: string): Promise<PromptResult> {
    return this.promptPart.checkPrompt(hash);
  }

  async projectView(): Promise<ProjectView> {
    return this.projectPart.projectView();
  }

  async previewArtStyle(style: string): Promise<PromptResult> {
    return this.projectPart.previewArtStyle(style);
  }

  /**
   * Write the project's art style. It is spliced into `project.yaml` rather than re-serialized,
   * so an author's comments and key order survive — the same posture the prose writers take with
   * front-matter.
   */
  async setProjectArtStyle(style: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectArtStyle(style);
  }

  async previewImageModel(modelId: string): Promise<PromptResult> {
    return this.projectPart.previewImageModel(modelId);
  }

  /** Write the project's image model, spliced into `project.yaml`'s `models:` block. */
  async setProjectImageModel(modelId: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectImageModel(modelId);
  }

  async previewTextModel(modelId: string): Promise<PromptResult> {
    return this.projectPart.previewTextModel(modelId);
  }

  /** Write the project's text model, spliced into `project.yaml`'s `models:` block. */
  async setProjectTextModel(modelId: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectTextModel(modelId);
  }

  async previewVisionModels(modelIds: readonly string[]): Promise<PromptResult> {
    return this.projectPart.previewVisionModels(modelIds);
  }

  /** Write the project's vision reviewers, spliced into `project.yaml`'s `models:` block. */
  async setProjectVisionModels(modelIds: readonly string[]): Promise<PromptWriteResult> {
    return this.projectPart.setProjectVisionModels(modelIds);
  }

  /** Fetch OpenRouter's image-model listing into `<user>/models.json`. */
  async refreshModelCatalog(
    fetchImpl?: FetchImpl,
  ): Promise<{ ok: true; message: string; listed: number } | { ok: false; reason: string }> {
    return this.projectPart.refreshModelCatalog(fetchImpl);
  }

  async previewStoryboardNotes(notes: string): Promise<PromptResult> {
    return this.projectPart.previewStoryboardNotes(notes);
  }

  /** Write the decomposer's directives, spliced into `project.yaml` like the art style. */
  async setProjectStoryboardNotes(notes: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectStoryboardNotes(notes);
  }

  async previewLettering(lettering: Lettering): Promise<PromptResult> {
    return this.projectPart.previewLettering(lettering);
  }

  /** Write who letters a page shot, spliced into `project.yaml` like the art style. */
  async setProjectLettering(lettering: Lettering): Promise<PromptWriteResult> {
    return this.projectPart.setProjectLettering(lettering);
  }

  async previewBubbleNames(on: boolean): Promise<PromptResult> {
    return this.projectPart.previewBubbleNames(on);
  }

  /** What `project.setShotForm` would do, without writing it. */
  async previewShotForm(form: ShotForm): Promise<PromptResult> {
    return this.projectPart.previewShotForm(form);
  }

  /** Write what a shot is, spliced into `project.yaml`. */
  async setProjectShotForm(form: ShotForm): Promise<PromptWriteResult> {
    return this.projectPart.setProjectShotForm(form);
  }

  /** Write whether bubbles name their speaker, spliced into `project.yaml` like the art style. */
  async setProjectBubbleNames(on: boolean): Promise<PromptWriteResult> {
    return this.projectPart.setProjectBubbleNames(on);
  }

  async previewBuiltinSkills(ids: readonly string[]): Promise<PromptResult> {
    return this.projectPart.previewBuiltinSkills(ids);
  }

  /** Write which builtin skills the project enables, spliced into `project.yaml`. */
  async setProjectBuiltinSkills(ids: readonly string[]): Promise<PromptWriteResult> {
    return this.projectPart.setProjectBuiltinSkills(ids);
  }

  async previewKey(vendor: keyof ResolvedKeys, scope: KeyScope = 'project'): Promise<PromptResult> {
    return this.projectPart.previewKey(vendor, scope);
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
    return this.projectPart.setKey(vendor, key, scope);
  }

  /**
   * For each vendor, whether a key resolved and which source answered — never the value. The
   * Setup pane is built on this, and so is the first-run check that decides whether to offer it.
   */
  async keyStatusView(): Promise<KeyStatusView> {
    return this.projectPart.keyStatusView();
  }

  /**
   * The key walkthrough, read from the one file that holds it and parsed into blocks.
   *
   * Parsed here rather than in the pane because main is the side with a filesystem: what crosses
   * the IPC boundary is already drawable, and the pane cannot end up with a second opinion about
   * what the page says.
   */
  async keyGuide(): Promise<KeyGuide> {
    return this.projectPart.keyGuide();
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
    return this.projectPart.openKeyLink(vendor, link);
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
    return this.projectPart.checkForUpdates();
  }

  /**
   * Open VN Studio's own releases page — the notes and the installers are one page there.
   *
   * The address is derived from `ISSUE_REPO` rather than passed in, for the reason
   * {@link openKeyLink} states: nothing in this app opens a URL it was handed, and a notification
   * — a line of a file git union-merges across clones — is exactly the input that rule is for.
   */
  async openReleases(): Promise<PromptResult> {
    return this.projectPart.openReleases();
  }

  /**
   * Whether {@link testKey} has anything to try, in its own sentence either way — so the Setup
   * pane's greyed-out button says why it is grey rather than looking broken.
   */
  async previewTestKey(vendor: keyof ResolvedKeys): Promise<PromptResult> {
    return this.projectPart.previewTestKey(vendor);
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
    return this.projectPart.testKey(vendor);
  }

  async previewConcept(
    sentence: string,
    subject: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewConcept(sentence, subject);
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
    return this.assetPart.drawConcept(sentence, subject);
  }

  async previewUpload(
    file: string,
    title: string,
    slot = '',
    replace = false,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewUpload(file, title, slot, replace);
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
    return this.assetPart.uploadAsset(file, title, slot, replace);
  }

  async previewAdopt(
    hash: string,
    slot: string,
    replace: boolean,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewAdopt(hash, slot, replace);
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
    return this.assetPart.adoptAsset(hash, slot, replace);
  }

  /**
   * Copy one asset's bytes to a path the author chose. Nothing about the project changes — this is
   * the picture leaving, not the project being edited — so no manifest is touched and no
   * provenance is written, and the path is deliberately not narrowed to the workspace.
   */
  async exportAsset(
    hash: string,
    file: string,
  ): Promise<{ ok: boolean; message: string; file?: string }> {
    return this.assetPart.exportAsset(hash, file);
  }

  async previewRestore(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewRestore(hash);
  }

  /**
   * Put an older take back in its slot and accept it, as one act.
   *
   * Accepting alone would only flip a manifest flag: the slot's task still names the later render,
   * so the runner and the exporter would go on using it. The adoption is what makes the picture
   * the slot's answer, and the accept is what the author meant by clicking Accept.
   *
   * The prompt these bytes were drawn from is kept rather than restamped with the slot's current
   * one, so the picture goes on reporting the drift it really has.
   */
  async restoreAsset(hash: string): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.restoreAsset(hash);
  }

  async previewReplace(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewReplace(hash);
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
    return this.assetPart.replaceAsset(hash, file);
  }

  async previewRedraw(
    hash: string,
    prompt: string,
    title: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewRedraw(hash, prompt, title);
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
    return this.assetPart.redrawAsset(hash, prompt, title);
  }

  async previewPromote(hash: string, variant: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewPromote(hash, variant);
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
    return this.assetPart.promoteAsset(hash, variant, description);
  }

  /**
   * The sidebar's logical tree plus per-entity backlinks. One load, one manifest, one storyboard
   * read per scene — which is exactly why this is not folded into `workspace:index`, the shape
   * the agent refetches every turn.
   */
  async docTree(): Promise<DocTree> {
    return this.docsPart.docTree();
  }

  /**
   * The project's skills, as the tree and the composer's `/` completion need them — one
   * `discoverSkills` per read. Only identity fields ship; the instruction body is dropped here
   * rather than sent to the renderer and ignored there.
   */
  async skillEntries(): Promise<SkillEntry[]> {
    return this.docsPart.skillEntries();
  }

  async fileTree(): Promise<DocNode[]> {
    return this.docsPart.fileTree();
  }

  /**
   * Every skill file the project can reach, as the Skills pane's own tree: a heading per tier, a
   * row per skill, and the files inside — the content the document tree deliberately leaves out.
   * Its own walk rather than a filter over `fileTree()`, which is capped across the whole
   * project and could truncate `.aiagent` away.
   */
  async skillTree(): Promise<DocNode[]> {
    return this.docsPart.skillTree();
  }

  /** Copy a skill into this project's `.aiagent/skills` or into the user's folder. */
  cloneSkill(
    id: string,
    into: 'project' | 'user',
  ): Promise<DocResult<{ path: string; written: string[] }>> {
    return this.docsPart.cloneSkill(id, into);
  }

  previewCloneSkill(
    id: string,
    into: 'project' | 'user',
  ): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
    return this.docsPart.previewCloneSkill(id, into);
  }

  /**
   * One authored document as text, with the hash it was read at. Deliberately not through
   * `@vn/bible`: that interface has no whole-file API and that absence is what keeps the bible
   * out of an agent's context window — a human reading their own note on screen is a different
   * act, and it reads the workspace directly.
   */
  readDoc(path: string): Promise<DocResult<{ file: DocFile }>> {
    return this.docsPart.readDoc(path);
  }

  previewDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocWritePlan>> {
    return this.docsPart.previewDoc(path, text, seenHash);
  }

  /**
   * Save one document whole, and say what the model will make of it. The refusals are
   * `checkDocWrite`'s; the schema check is here because it needs `@vn/model`, which `@vn/store`
   * may not import — and because a failure there is a diagnostic beside a saved file rather than
   * a refusal, exactly the split `loadInputs` already draws.
   */
  async saveDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocSaveResult>> {
    return this.docsPart.saveDoc(path, text, seenHash);
  }

  async previewCreate(kind: NewDocKind, name: string): Promise<DocResult<DocWritePlan>> {
    return this.docsPart.previewCreate(kind, name);
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
    return this.docsPart.createDoc(kind, name);
  }

  async previewRename(path: string, name: string): Promise<DocResult<{ note: string }>> {
    return this.docsPart.previewRename(path, name);
  }

  /**
   * Rename one document in place. The file never moves: an id is derived from a name once, at
   * creation, and afterwards it is what shots, cast lists and `[[goto:]]` markers point at.
   */
  async renameDoc(
    path: string,
    name: string,
  ): Promise<DocResult<DocSaveResult & { what: string }>> {
    return this.docsPart.renameDoc(path, name);
  }

  async storyGraph(): Promise<StoryGraph> {
    return this.storyPart.storyGraph();
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
    return this.storyPart.editBranches(decide);
  }

  /**
   * The scenes a prose edit is decided against: as their chunks parse, with cues still the ones
   * the author typed — deliberately not the model's, which resolves each cue to a character id.
   * This is what an interaction's `targets` enumerates over; a command's own `check` goes through
   * `previewSceneEdit`, which decides against this same state and prices the storyboard too.
   */
  async scriptState(): Promise<ScriptState> {
    return this.storyPart.scriptState();
  }

  async previewSceneEdit(
    decide: (state: ScriptState) => LineOp,
  ): Promise<{ ok: boolean; message: string }> {
    return this.storyPart.previewSceneEdit(decide);
  }

  /**
   * The single write path for every prose edit, and the sibling of `editBranches`: apply the proved
   * plan — chunks, storyboards, removals — then rebuild the model. The app's own part is reporting:
   * `applyScenePlan` answers in absolute paths, and a `written` list is workspace-relative.
   */
  async editScene(decide: (state: ScriptState) => LineOp): Promise<SceneEditResult> {
    return this.storyPart.editScene(decide);
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
    return this.storyPart.shotOrder(sceneId, shot, after);
  }

  async previewLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; assigned: number }> {
    return this.storyPart.previewLineIds(sceneId);
  }

  /**
   * Persist the ids reading already allocated as `[[line:]]` marks. Nothing about the model
   * changes — the ids are the same ones `splitScenes` handed out — so this writes the prose
   * files and reports; what it buys is that a later insertion can no longer shift them.
   */
  async writeLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.storyPart.writeLineIds(sceneId);
  }

  async previewImport(): Promise<{ ok: boolean; message: string }> {
    return this.storyPart.previewImport();
  }

  /**
   * Convert a `screenplay/*.fountain` project into one chunk per scene — the `vngen import`
   * equivalent. The screenplay is moved aside rather than deleted, and moved last: while it is
   * still a `.fountain` the project reports it on every load, so the rename finishes the import.
   */
  async importScreenplay(): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.storyPart.importScreenplay();
  }

  /**
   * One scene's script and shots for the coverage timeline. Shots come off disk: a model built
   * from inputs carries none, and the persisted decomposition is the one the run illustrated.
   */
  async sceneCoverage(sceneId: string): Promise<SceneCoverage> {
    return this.storyPart.sceneCoverage(sceneId);
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
    return this.storyPart.setCoverage(sceneId, shotId, lines);
  }

  async sceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<(scenes: Map<string, Scene>) => SceneOutfitOp> {
    return this.storyPart.sceneOutfit(sceneId, character, outfit);
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
    return this.storyPart.previewSceneOutfit(sceneId, character, outfit);
  }

  async previewShotOutfit(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotOutfit(sceneId, shotId, character, outfit);
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
    return this.storyPart.setShotOutfit(sceneId, shotId, character, outfit);
  }

  async previewShotVariant(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotVariant(sceneId, shotId, variant);
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
    return this.storyPart.setShotVariant(sceneId, shotId, variant);
  }

  async previewShotSubjects(
    sceneId: string,
    shotId: string,
    subjects: readonly string[],
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotSubjects(sceneId, shotId, subjects);
  }

  /**
   * Set the characters one shot frames. Like `setShotOutfit` this changes the shot's prompt, so
   * the shot re-hashes and the next run re-renders it — and it changes which character sheets are
   * carried in as references, so the frame is drawn from different material as well.
   */
  async setShotSubjects(
    sceneId: string,
    shotId: string,
    subjects: readonly string[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setShotSubjects(sceneId, shotId, subjects);
  }

  async previewShotCast(sceneId: string, shotId: string, required: boolean): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotCast(sceneId, shotId, required);
  }

  /**
   * Say whether one shot's cast has to be in the frame it produces. The subjects stay on the shot
   * either way, so the references it is drawn from do not change; only the reviewer's demand does.
   * It is in the prompt, so the frame is drawn again on the next run.
   */
  async requireShotCast(
    sceneId: string,
    shotId: string,
    required: boolean,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.requireShotCast(sceneId, shotId, required);
  }

  async previewPanels(
    sceneId: string,
    shotId: string,
    panels: readonly PagePanel[],
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewPanels(sceneId, shotId, panels);
  }

  /**
   * Replace one shot's panels. Every part of a panel is in the page's prompt, so the page re-hashes
   * and the next run draws it again; an empty list makes the shot a single frame.
   */
  async setPanels(
    sceneId: string,
    shotId: string,
    panels: readonly PagePanel[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setPanels(sceneId, shotId, panels);
  }

  async previewBubbles(
    sceneId: string,
    shotId: string,
    bubbles: readonly PanelBubble[],
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewBubbles(sceneId, shotId, bubbles);
  }

  /** Restates where the runner draws one page's bubbles; nothing re-hashes. */
  async setBubbles(
    sceneId: string,
    shotId: string,
    bubbles: readonly PanelBubble[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setBubbles(sceneId, shotId, bubbles);
  }

  async previewSheet(sceneId: string, shotId: string, sheet: string): Promise<SheetsOp<Shot>> {
    return this.storyPart.previewSheet(sceneId, shotId, sheet);
  }

  /** Puts one shot in a staging-sheet group, or takes it out; every member re-keys. */
  async setSheet(
    sceneId: string,
    shotId: string,
    sheet: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setSheet(sceneId, shotId, sheet);
  }

  async previewSheetGroup(
    sceneId: string,
    args: { sheet: string; seed?: number; notes?: string },
  ): Promise<SheetsOp<Shot>> {
    return this.storyPart.previewSheetGroup(sceneId, args);
  }

  /** Sets a sheet group's seed and notes; a new seed is how a sheet is rerolled. */
  async setSheetGroup(
    sceneId: string,
    args: { sheet: string; seed?: number; notes?: string },
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setSheetGroup(sceneId, args);
  }

  async previewNewShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ): Promise<NewShotOp> {
    return this.storyPart.previewNewShot(sceneId, lines, framing, subjects);
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
    return this.storyPart.newShot(sceneId, lines, framing, subjects);
  }

  async previewDeleteShot(sceneId: string, shotId: string): Promise<DeleteShotOp> {
    return this.storyPart.previewDeleteShot(sceneId, shotId);
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
    return this.storyPart.deleteShot(sceneId, shotId);
  }

  async playable(): Promise<Playable> {
    return this.pipelinePart.playable();
  }

  async exportPlayable(): Promise<{ path: string; scenes: number }> {
    return this.pipelinePart.exportPlayable();
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
    return this.pipelinePart.writeScreenplay(clean);
  }

  async status(): Promise<PipelineStatus> {
    return this.pipelinePart.status();
  }

  /**
   * One graph's document, for a renderer that cannot reach the file. The graph is serialized
   * back to the file's own layout rather than to the DSL, because the DSL carries no node
   * positions and the pane has to draw the graph where the author left it.
   *
   * Answered from the held parse when a stat says neither the file nor any definition it resolved
   * has moved. Building one costs a read, a JSON parse, an nstructjs deserialize, a walk of the
   * group library off disk, a validation pass and a re-serialize, and a pane re-reads after every
   * write — so the reads that change nothing are the ones worth not paying for. The stats are what
   * keep a writer this process never saw, such as the CLI or a `git checkout` touching `lib/`,
   * from being served a stale parse.
   */
  async graphDoc(slug: GraphSlug): Promise<GraphDocRead> {
    return this.gengraphPart.graphDoc(slug);
  }

  /**
   * One group definition from `lib/`, for the pane's `groupLoader`. Held and stamped the way a
   * graph is, against its own file and those of the definitions it instances in turn.
   */
  async groupDoc(ref: string): Promise<GroupDocRead> {
    return this.gengraphPart.groupDoc(ref);
  }

  /**
   * Drop every held parse when a write names anything under the graph directory.
   *
   * All of them rather than the one file written: the stamps would catch it on the next serve,
   * but the set is a handful of entries, and dropping them all is cheaper than being wrong.
   */
  forgetGraphDocs(written: readonly string[]): void {
    return this.gengraphPart.forgetGraphDocs(written);
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
    return this.gengraphPart.graphEstimate(slug);
  }

  /**
   * Runs a plugin's price agent and folds what it answers into the author's own table. The
   * caller has confirmed the spend, because the agent calls a model on the author's key.
   */
  async refreshPrices(
    plugin: string,
  ): Promise<{ ok: true; models: string[]; pricesAsOf: string } | { ok: false; reason: string }> {
    return this.gengraphPart.refreshPrices(plugin);
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
    return this.gengraphPart.runGraph(slug, opts);
  }

  /** Why `runGraph` with `force` would refuse this graph, or undefined when it would run. */
  forceRefusal(graph: GenGraph): string | undefined {
    return this.gengraphPart.forceRefusal(graph);
  }

  /** The scaffold `gengraph.scaffoldSheet` would write for a scene's sheet group, or a refusal. */
  async planSheet(
    sceneId: string,
    group: string,
    name: string,
  ): Promise<SheetScaffoldPlan | { refuse: string }> {
    return this.gengraphPart.planSheet(sceneId, group, name);
  }

  /** Writes a planned sheet scaffold and reports the workspace paths it wrote. */
  async scaffoldSheet(plan: SheetScaffoldPlan): Promise<string[]> {
    return this.gengraphPart.scaffoldSheet(plan);
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
    return this.gengraphPart.runPreconditions(mock);
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
    return this.gengraphPart.decomposePreconditions();
  }

  /**
   * Decompose every reachable scene that has no storyboard yet. Real providers always: a mock
   * decomposition is the deterministic baseline, and `decomposeAll` would decline to write it —
   * so running this against mocks would be a no-op that looked like work.
   */
  async decomposeAllScenes(): Promise<DecomposeAllResult> {
    return this.gengraphPart.decomposeAllScenes();
  }

  async runPipeline(mock: boolean, only?: readonly string[]): Promise<PipelineRunResult> {
    return this.gengraphPart.runPipeline(mock, only);
  }
}
