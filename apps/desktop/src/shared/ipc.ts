/**
 * The single source of truth for the renderer ↔ main IPC contract. Both the preload bridge
 * and the renderer import these names + payload shapes, so a channel can't drift
 * between the two sides without a type error.
 *
 * Shapes are re-exported from the real `@vn/*` packages (type-only) rather than redefined,
 * so the desktop app stays bound to the same `AgentEvent` / `Plan` / `Task` types the
 * agent and scheduler actually emit.
 */
import type {
  AgentEvent,
  AgentMode,
  Plan,
  PlanDecision,
  RunResult,
  WorkspaceIndex,
} from '@vn/authoring';
import type {
  AssetKind,
  AssetRef,
  DefectReport,
  Diagnostic,
  Drift,
  Playable,
  SceneLine,
  Shot,
  Task as PipelineTask,
  TaskAttempt as PipelineTaskAttempt,
  TaskKind,
} from '@vn/types';
import type {
  CommandCatalog,
  CommandOutcome,
  CommandRecord,
  CommandSource,
  PropValue,
  UndoState,
} from '@vn/commands';

export type {
  CatalogEntry,
  CatalogProp,
  CommandCatalog,
  CommandOutcome,
  CommandRecord,
  CommandSource,
  PropValue,
  UndoState,
} from '@vn/commands';

import type { EditorId, OpenWhere } from './editors.js';

export type { EditorId, OpenWhere } from './editors.js';

/** Anything the desktop session store can persist — plain JSON, nothing else. */
export type SessionValue =
  | string
  | number
  | boolean
  | null
  | SessionValue[]
  | { [k: string]: SessionValue };

/**
 * A UI change a command asks the renderer to apply. `view.*` commands run in main like any
 * other command — one registry, one catalog, reachable from CDP — and push the effect here
 * rather than the renderer keeping a second registry in sync.
 */
export type UiEffect =
  | { type: 'palette'; open: boolean }
  /**
   * Where an editor goes and which pane is active. An effect names an **editor**, never a room:
   * the shell is a mesh of panes an author arranges, so "show me the coverage strip" is a
   * different act from "put it beside the script", and both are one command away.
   */
  | { type: 'view'; action: 'open'; editor: EditorId; where: OpenWhere }
  | { type: 'view'; action: 'focus'; editor: EditorId }
  | { type: 'view'; action: 'close' }
  | { type: 'view'; action: 'reset' }
  /**
   * Pushed after every command, so the undo/redo affordances stay honest whoever ran it — the
   * palette, a drag, or CDP. `revision` counts undo/redo moves **only**: those are the writes
   * a room did not make itself, so it is what a room remounts on. An ordinary command already
   * refreshes the surface that issued it.
   */
  | { type: 'undo'; state: UndoState; revision: number }
  /**
   * A different project is open. Everything the shell holds was read out of the old workspace,
   * so this is a remount and not a refresh — the session, the command history and the undo
   * stack were all torn down with the old root.
   */
  | { type: 'workspace'; root: string; title: string };

/** Either form of invocation accepted over `command:exec`: structured, or a DSL string. */
export interface CommandExecRequest {
  id?: string;
  props?: Record<string, PropValue>;
  dsl?: string;
  source?: CommandSource;
}

/** A precondition's answer. Three states: absence of a check is `undeclared`, not `accept`. */
export interface CommandCheck {
  state: 'accept' | 'refuse' | 'undeclared';
  message: string;
}

export type {
  AgentEvent,
  AgentMode,
  CharacterEntry,
  Plan,
  PlanDecision,
  RunResult,
  WorkspaceIndex,
} from '@vn/authoring';
// Type-only, so the browser bundle never pulls in `@vn/bible` (which reads the filesystem):
// `bible.search` results cross the wire as data, and this is the shape the renderer names.
export type { BibleFile, Excerpt } from '@vn/bible';
export type { Playable, Beat, PlayableScene, TaskKind, TaskStatus } from '@vn/types';
export type { Defect, DefectReport, Diagnostic } from '@vn/types';

/**
 * `TaskAttempt.reviews` is `unknown[]` in `@vn/types` — it is read back from `tasks.jsonl` as
 * JSON on resume, so the persisted type cannot claim more than it can prove. Main narrows it
 * once, at the boundary, and the renderer consumes the narrowed shape.
 */
export interface TaskAttempt extends Omit<PipelineTaskAttempt, 'reviews'> {
  reviews: DefectReport[];
  /**
   * Extension of `output` in the asset store. An attempt records only the hash, so main
   * looks the ext up in the manifest — the renderer needs both halves to build a
   * `vnasset://<hash>.<ext>` url, and guessing `png` would silently mis-serve anything else.
   */
  outputExt?: string;
}

/** A task as the renderer sees it: identical to the pipeline's, with validated `reviews`. */
export interface Task extends Omit<PipelineTask, 'attempts'> {
  attempts: TaskAttempt[];
}

/** A request from the main process for the user to approve/reject a proposed plan. */
export interface PlanRequest {
  id: number;
  plan: Plan;
}

/** A snapshot of pipeline state for the Floor view. */
export interface PipelineStatus {
  tasks: Task[];
  /** Character ids still awaiting portrait approval (the gate). */
  gatePending: string[];
  blockedOnGate: boolean;
}

/** Result of kicking off a pipeline run to the next gate. */
export interface PipelineRunResult {
  ran: number;
  blockedOnGate: boolean;
  gatePending: string[];
  preview: { pendingTasks: number; imageCalls: number; reviewCalls: number };
  /**
   * Tasks the current plan wants that are `failed`, including failures inherited from an
   * earlier run — which `ran` cannot see, so a run that lost art used to report as clean.
   */
  failed: number;
  failures: { hash: string; kind: TaskKind; error?: string }[];
}

/** A portrait candidate offered for a character at the approval gate. */
export interface GateCandidate {
  hash: string;
  accepted: boolean;
}

/** Outcome of approving a character's portrait. */
export interface ApproveResult {
  ok: boolean;
  message: string;
}

/** One scene as the branch editor draws it — the card face, not the screenplay text. */
export interface StoryScene {
  id: string;
  location: string;
  synopsis?: string;
  characters: string[];
  /** How many screenplay lines it holds; the card shows weight, not the prose. */
  lines: number;
  /** Reachable from the entry scene. An unreachable scene is drawn dashed. */
  reachable: boolean;
}

/**
 * One branch edge. `id` is `<from>#choice:<index>` or `<from>#next` — stable across reloads
 * (so the view can keep a selection) and enough on its own to address the edge in the
 * `story.*` command that would change it.
 */
export interface StoryEdge {
  id: string;
  from: string;
  to: string;
  kind: 'choice' | 'next';
  /** The decision text, typeset on the wire. Choices only. */
  label?: string;
  /** Position in `from`'s choice list. Choices only. */
  index?: number;
  /** `to` names no scene in the model — drawn as a stub, and a model diagnostic. */
  dangling: boolean;
  /**
   * The runner will never follow this edge: a `next` on a scene that also forks. Reachability
   * still counts it, so it is drawn — struck through — rather than hidden.
   */
  inert?: boolean;
}

/** The story's branch structure, derived from the model for the editor. */
export interface StoryGraph {
  /** Entry scene id — the graph's root. */
  start?: string;
  scenes: StoryScene[];
  edges: StoryEdge[];
  /** Model diagnostics, so the editor can say *why* a scene is flagged. */
  diagnostics: Diagnostic[];
}

/** One screenplay line as the timeline sets it: the authored side of the strip. */
export interface CoverageLine {
  id: string;
  kind: SceneLine['kind'];
  speaker?: string;
  text: string;
}

/** One shot as a bracket: what it covers, and the frame it produced (if any). */
export interface CoverageShot {
  id: string;
  framing: string;
  /** Character ids in frame; empty is a background plate. */
  subjects: string[];
  /**
   * Per-subject outfit *overrides*, character id → outfit id. A subject absent from this map
   * inherits — an empty map is the normal state, not an unfilled one.
   */
  outfits: Record<string, string>;
  coversLines: string[];
  status: Shot['status'];
  /** The accepted frame, for the thumbnail. Absent until a run produced one. */
  image?: AssetRef;
  /**
   * Whether that frame still illustrates the lines it covers. Derived in main, because the
   * comparison is a sha256 over line text and the renderer has no crypto — and because the task
   * list and the inspector must give the same answer as this strip.
   */
  drift: Drift;
}

/**
 * One member of a scene's cast, with the clothes they could be put in. The wardrobe travels with
 * the coverage because the strip's outfit controls have to offer exactly what the command would
 * accept — a select built from anything else would offer refusals.
 */
export interface CoverageCast {
  id: string;
  /** Outfit ids the sheet authors, in order; always contains {@link defaultOutfit}. */
  outfits: string[];
  defaultOutfit: string;
  /** The scene's `[[outfit:]]` marker for them, when there is one. */
  marked?: string;
}

/**
 * A scene's script and its shots, the timeline's whole input. Shots come from the persisted
 * decomposition (`work/shots/<sceneId>.json`) — a model loaded from disk carries none.
 */
export interface SceneCoverage {
  sceneId: string;
  location: string;
  lines: CoverageLine[];
  shots: CoverageShot[];
  /** Who is in the scene and what they own; the scene half of the outfit strip. */
  cast: CoverageCast[];
  /** No decomposition on disk yet: the scene has not been planned past the gate. */
  decomposed: boolean;
}

/**
 * What a document-tree node is. `branch` is a pure grouping (the five roots); `dir`/`file` only
 * appear in the full file tree; `more` is the counted stand-in for children a cap dropped.
 */
export type DocNodeKind =
  | 'branch'
  | 'scene'
  | 'shot'
  | 'character'
  | 'location'
  | 'wikidir'
  | 'wiki'
  | 'assetkind'
  | 'asset'
  | 'dir'
  | 'file'
  | 'more';

/**
 * One node of the sidebar's tree. Identity, not content — and deliberately not an action: there
 * is no command that selects a scene or a shot yet, so what a click does stays the shell's.
 */
export interface DocNode {
  /**
   * `<kind>:<key>` — `scene:greet`, `shot:greet/s1`, `character:aiko`. Stable across reloads (so
   * expansion state survives) and the key {@link DocTree.backlinks} is keyed by.
   */
  id: string;
  kind: DocNodeKind;
  label: string;
  /** Workspace-relative, `/` separators. Absent for a grouping, and for an entity with no sheet. */
  path?: string;
  /** One word, never a sentence: `unreachable`, `draft`, `mined`, `base`, `accepted`. */
  badge?: string;
  children?: DocNode[];
}

/** Everything one entity is attached to. The panel behind a click on a character or a location. */
export interface EntityLinks {
  /** The sheet it was discovered in, wherever that was. Absent for a mined location. */
  sheet?: string;
  /** That same sheet when it lives under `wiki/` — the "story bible file" link. */
  wiki?: string;
  assets: {
    hash: string;
    ext: string;
    kind: AssetKind;
    accepted: boolean;
    /** Routed to the base root — see `isBaseKind`, which is the one place that is decided. */
    base: boolean;
  }[];
  scenes: string[];
  shots: { scene: string; shot: string }[];
}

/**
 * The sidebar's default view: five branches plus the backlinks behind them. One shape because it
 * is one walk — the scene → shot tree and "which shots is Aiko in" read the same storyboards.
 */
export interface DocTree {
  roots: DocNode[];
  /** Keyed by node id (`character:aiko`), so a panel is a lookup rather than a second convention. */
  backlinks: Record<string, EntityLinks>;
}

/** Outcome of a `story.*` branch edit: the patched graph, or why the patch was refused. */
export interface BranchEditResult {
  ok: boolean;
  message: string;
  /** Workspace-relative paths written — empty when the edit was refused or a no-op. */
  written: string[];
  /** The rebuilt graph; absent on refusal. */
  graph?: StoryGraph;
}

/**
 * Outcome of a `story.*` prose edit. Separate from `BranchEditResult` because a prose edit can
 * change the scene *set* — a split adds a chunk, a delete or a merge removes one — so what
 * happened is not fully described by the files that were written.
 */
export interface SceneEditResult {
  ok: boolean;
  message: string;
  /** Workspace-relative paths written — empty when the edit was refused or changed nothing. */
  written: string[];
  /** Workspace-relative files deleted: a chunk the edit ended, and any shots file with it. */
  removed: string[];
  /** The rebuilt graph; absent on refusal. Wiring moves with a split or a merge. */
  graph?: StoryGraph;
}

/**
 * Channels invoked by the renderer and answered by main (request → response).
 * Keep the key as the literal channel string; the value types the (args) → result.
 */
export interface InvokeChannels {
  'workspace:index': () => WorkspaceIndex;
  /**
   * The sidebar's logical tree + backlinks. Its own channel rather than a wider index: this one
   * reads every scene's storyboard and the manifest, and `workspace:index` is fetched on every
   * agent turn. Refetched after a write, like `story:graph`.
   */
  'workspace:doctree': () => DocTree;
  /** Every file on disk, `.git` and `node_modules` excluded, capped. The tree's other mode. */
  'workspace:filetree': () => DocNode[];
  'agent:run': (userInput: string) => RunResult;
  'agent:setMode': (mode: AgentMode) => AgentMode;
  'agent:setModel': (modelId: string) => string;
  'agent:clear': () => void;
  'plan:decision': (payload: { id: number; decision: PlanDecision }) => void;
  'pipeline:status': () => PipelineStatus;
  'pipeline:run': (opts: { mock: boolean }) => PipelineRunResult;
  'gate:candidates': (characterId: string) => GateCandidate[];
  'gate:approve': (payload: { characterId: string; hash: string }) => ApproveResult;
  /** Build the playable (`story.play.json` shape) live from the loaded model + store. */
  'story:play': () => Playable;
  /**
   * The branch structure for the editor. A read, so it gets a typed channel; every branch
   * *mutation* goes through a `story.*` command instead, for one provenance record per act.
   */
  'story:graph': () => StoryGraph;
  /**
   * One scene's lines + persisted shots. FLOOR's coverage timeline and STUDIO's script column
   * both read it — one line-level read rather than two that could disagree about what a scene
   * contains. A read; the edit goes through a `story.*` command like every other mutation.
   */
  'story:coverage': (sceneId: string) => SceneCoverage;
  /** The live registry projection — never the generated file, so the two can't diverge. */
  'command:catalog': () => CommandCatalog;
  'command:exec': (request: CommandExecRequest) => CommandOutcome;
  'command:history': (limit?: number) => CommandRecord[];
  /**
   * Would that invocation run? A read, never a gate — `command:exec` re-decides for itself.
   * `undeclared` is the honest answer for a command that states no precondition.
   */
  'command:check': (request: { id: string; props?: Record<string, PropValue> }) => CommandCheck;
  /** Restores a snapshot; refuses (never guesses) if the workspace moved — see `@vn/commands`. */
  'command:undo': () => CommandOutcome;
  'command:redo': () => CommandOutcome;
  /** Persist one piece of UI state; the initial read is the synchronous preload snapshot. */
  'session:set': (payload: { key: string; value: SessionValue }) => void;
}

/** Events pushed from main to the renderer (fire-and-forget). */
export interface EventChannels {
  'agent:event': AgentEvent;
  'permission:plan': PlanRequest;
  'command:ui': UiEffect;
  /** A session key changed — either by this window or by a command that wrote one. */
  'session:changed': { key: string; value: SessionValue };
  log: { level: 'info' | 'warn' | 'error'; message: string };
}

export type InvokeChannel = keyof InvokeChannels;
export type EventChannel = keyof EventChannels;

/** The typed surface the preload exposes on `window.api`. */
export interface DesktopApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: Parameters<InvokeChannels[C]>
  ): Promise<ReturnType<InvokeChannels[C]>>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventChannels[C]) => void): () => void;
  /**
   * Persisted UI state (see `SessionStore`). `initial()` is deliberately synchronous — an
   * async fetch would paint the panels at their defaults and then jump to the saved widths.
   */
  session: {
    initial(): Record<string, SessionValue>;
    set(key: string, value: SessionValue): void;
  };
}

/**
 * The scripting surface the preload exposes on `window.vn` — the entry point for DevTools
 * and for CDP `Runtime.evaluate`. `exec` takes either a DSL string on its own
 * (`vn.exec("view.open(editor='timeline')")`) or an id plus a props object.
 */
export interface CommandBridge {
  exec(dslOrId: string, props?: Record<string, PropValue>): Promise<CommandOutcome>;
  /** Ask a command's precondition without running it. Same argument forms as `exec`. */
  check(id: string, props?: Record<string, PropValue>): Promise<CommandCheck>;
  catalog(): Promise<CommandCatalog>;
  history(limit?: number): Promise<CommandRecord[]>;
  undo(): Promise<CommandOutcome>;
  redo(): Promise<CommandOutcome>;
}
