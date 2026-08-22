/**
 * The single source of truth for the renderer ↔ main IPC contract. Both the preload bridge
 * and the renderer import these names + payload shapes, so a channel can't drift
 * between the two sides without a type error.
 *
 * Shapes are re-exported from the real `@vn/*` packages (type-only) rather than redefined,
 * so the desktop app stays bound to the same `AgentEvent` / `Plan` / `Task` types the
 * agent and scheduler actually emit.
 */
import type { LayoutFile } from './layouts.js';
import type { PromptView } from './prompt.js';
import type { Coverage as PkgCoverage, ShotSpan as PkgShotSpan } from '@vn/scriptedit';
import type {
  AgentEvent,
  AgentMode,
  AskQuestion,
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
  Notification,
  NotificationInput,
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

export type {
  Notification,
  NotificationCategory,
  NotificationInput,
  NotificationLevel,
  NotificationLink,
} from '@vn/types';

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
   * Where an editor goes and which pane is active. An effect names an editor, never a room,
   * because the shell is a mesh of panes the author arranges.
   *
   * `subject` is the document to show once the editor is there — a workspace-relative path,
   * published as `ui.docPath`. It is optional because most editors read their subject off the
   * selection they already observe; without it, opening a document editor on a file would be
   * two acts that race.
   *
   * `flash` outlines the pane once when it lands, for commands that move the author somewhere
   * they did not click (`upload.pick` opening a conversation). It matters most when the pane was
   * already open and focused, because nothing else about it would visibly change.
   */
  | {
      type: 'view';
      action: 'open';
      editor: EditorId;
      where: OpenWhere;
      subject?: string;
      flash?: boolean;
    }
  | { type: 'view'; action: 'focus'; editor: EditorId; subject?: string; flash?: boolean }
  | { type: 'view'; action: 'close' }
  | { type: 'view'; action: 'reset' }
  /**
   * Rearrange the whole window to a layout template. Main reads the file and sends its contents,
   * because only main may read the project and only the renderer can build a mesh. `fingerprint`
   * tells the renderer whether the arrangement it is already showing is still the one on disk.
   */
  | { type: 'view'; action: 'apply'; slug: string; fingerprint: string; layout: LayoutFile }
  /**
   * Pushed after every command, whether it came from the palette, a drag or CDP, so the
   * undo/redo affordances stay accurate. `revision` counts undo and redo moves and nothing else,
   * since those are the writes a room did not make itself, and it is what a room remounts on. An
   * ordinary command already refreshes the surface that issued it.
   */
  | { type: 'undo'; state: UndoState; revision: number }
  /**
   * A different project is open. Everything the shell holds was read out of the old workspace,
   * so this is a remount and not a refresh — the session, the command history and the undo
   * stack were all torn down with the old root.
   */
  | { type: 'workspace'; root: string; title: string }
  /**
   * Long-running work started, moved, or ended. `what` names the work in plain words ("a
   * pipeline run", "an agent turn") and is absent when the session went idle. This is pushed
   * rather than polled, so that the header's run button and the conversation editor's stop
   * button both read the state `WorkspaceSession.busy()` already tracks.
   */
  | { type: 'busy'; what?: string; ran: number; pending: number }
  /**
   * A model call failed in a way the request itself explains — a rejected body, not a rate limit
   * and not a bad key — and the author picked "look into what went wrong" on the card that
   * offered it.
   *
   * This is pushed rather than answered on request, because `WorkspaceSession.while()` is a `Set`
   * rather than a mutex: a "last fault" the renderer came back and asked for could be overwritten
   * by a second turn between the failure and the question. `message` is the provider's own
   * sentence, shown on the dialog so it says why it opened.
   */
  | { type: 'agent'; action: 'diagnose'; thread?: string; message: string };

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
  AskQuestion,
  CharacterEntry,
  Plan,
  PlanDecision,
  RunResult,
  WorkspaceIndex,
} from '@vn/authoring';
// Type-only, so the browser bundle never pulls in `@vn/bible` (which reads the filesystem):
// `bible.search` results cross the wire as data, and this is the shape the renderer names.
export type { BibleFile, Excerpt } from '@vn/bible';
// Type-only for the same reason: `@vn/artgen` reads prompts off the model, and the renderer names
// this shape only as data that already crossed the wire.
import type { Prereq, SlotNode } from '@vn/artgen';
export type { Prereq, SlotNode };
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

/**
 * A form the agent put to the author, waiting on answers main is blocked for.
 *
 * `questions` is never empty and usually holds one, which the card draws as a one-page form. A
 * question's `choices` is a shortlist to click rather than type; it changes how the page is drawn
 * and nothing else, since the answer that goes back is a string either way and the author may
 * always type something the list omits.
 */
export interface AskRequest {
  id: number;
  questions: AskQuestion[];
}

/**
 * An always-confirm tool waiting for a yes. `detail` is an English sentence rather than the raw
 * arguments, because main interprets a tool's arguments and the card only reads the result out.
 */
export interface ConfirmRequest {
  id: number;
  tool: string;
  detail: string;
}

/** A snapshot of pipeline state for the Floor view. */
export interface PipelineStatus {
  tasks: Task[];
  /** Character ids still awaiting portrait approval (the gate). */
  gatePending: string[];
  blockedOnGate: boolean;
  /**
   * Every picture the project implies, in `SlotGraph.order` — upstream before downstream. `tasks`
   * holds only what was plannable at the last wave, so a view drawn from tasks alone would have
   * to guess at the rest. This list covers the whole graph.
   */
  slots: SlotNode[];
}

/** Result of kicking off a pipeline run to the next gate. */
export interface PipelineRunResult {
  ran: number;
  blockedOnGate: boolean;
  gatePending: string[];
  preview: { pendingTasks: number; imageCalls: number; reviewCalls: number };
  /**
   * Tasks the current plan wants that are `failed`, including failures inherited from an earlier
   * run. `ran` cannot see those, so a run that lost art would otherwise report as clean.
   */
  failed: number;
  failures: { hash: string; kind: TaskKind; error?: string }[];
  /** True when the author stopped the run. What it finished is recorded; the rest is pending. */
  stopped?: boolean;
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
  /** How many screenplay lines it holds; the card shows the count rather than the prose. */
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
  /** The decision text, already formatted before it is sent. Choices only. */
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
  /** Model diagnostics, so the editor can say why a scene is flagged. */
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
   * Per-subject outfit overrides, character id → outfit id. A subject absent from this map
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
 * The coverage geometry from `@vn/scriptedit`, specialized to this app's rich projections. The
 * generic `spansFor` hands the same {@link CoverageShot} back with its drift, status and image
 * intact, and the timeline annotates its spans under these names.
 */
export type Coverage = PkgCoverage<CoverageLine, CoverageShot>;
export type ShotSpan = PkgShotSpan<CoverageShot>;

/**
 * One member of a scene's cast, with the clothes they could be put in. The wardrobe is sent with
 * the coverage because the strip's outfit controls have to offer exactly what the command would
 * accept; a select built from anything else would offer refusals.
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
  /**
   * The slugline as the file holds it, reassembled by `headingOf`. A scene has no `heading` field,
   * so a surface that offers to edit one has nowhere else to read the current value from.
   */
  heading: string;
  lines: CoverageLine[];
  shots: CoverageShot[];
  /** Who is in the scene and what they own; the scene half of the outfit strip. */
  cast: CoverageCast[];
  /** No decomposition on disk yet: the scene has not been planned past the gate. */
  decomposed: boolean;
  /**
   * The storyboard's persisted shot-id high-water mark, when the file records one — so a surface
   * previewing `story.newShot` names the id the write would actually mint, not a derived guess.
   */
  nextShot?: number;
}

/**
 * What a document-tree node is. `branch` is a pure grouping (the roots); `dir`/`file` only
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
  /** A picture the project implies with no bytes yet — an address (`plate:cafe/night`), not a file. */
  | 'slot'
  /** A reusable playbook under `.aiagent/skills/` — the skill itself, never the files inside it. */
  | 'skill'
  | 'dir'
  | 'file'
  | 'more';

/**
 * One node of the sidebar's tree. It carries identity, not content, and is deliberately not an
 * action: no command selects a scene or a shot yet, so what a click does is decided by the shell.
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
  /** One word, never a sentence: `unreachable`, `draft`, `mined`, `base`, `accepted`, `stale`, `script`. */
  badge?: string;
  /**
   * The row's tooltip, for rows where the path is not the useful thing to say — for example a
   * slot's `blocked` sentence. Without it a pathless row would carry no hover text at all, which
   * the tooltip rule forbids.
   */
  note?: string;
  children?: DocNode[];
}

/**
 * Everything one subject is attached to — a character, a location, or a scene. The panel behind a
 * click in the tree, and the strip a document editor draws under itself.
 */
export interface EntityLinks {
  /** The sheet it was discovered in, wherever that was. Absent for a mined location. */
  sheet?: string;
  /** That same sheet when it lives under `wiki/` — the "story bible file" link. */
  wiki?: string;
  assets: {
    hash: string;
    ext: string;
    kind: AssetKind;
    /** Display name — `Aiko — uniform / front`, or `hash8.ext` when nothing claims it. */
    label: string;
    accepted: boolean;
    /** Routed to the base root — see `isBaseKind`, which is the one place that is decided. */
    base: boolean;
    /**
     * The shot this asset frames, when the binding that matched named one. Present only for a
     * scene's links, where it is what lets a strip group frames by the shot they illustrate.
     */
    shotId?: string;
  }[];
  scenes: string[];
  shots: { scene: string; shot: string }[];
}

/** One rung of the art rung chain as a surface shows it — see `main/artnotes.ts`. */
export interface ArtRungInfo {
  /** `art.setNotes`'s address for this rung: `character:aiko/gala`, `location:cafe/night`. */
  target: string;
  label: string;
  notes?: string;
  /** The seed authored here; absent means the rung inherits, down to the project config. */
  seed?: number;
}

/** The pipeline gave up on the picture an asset fills, and what it recorded when it did. */
export interface AssetFailure {
  /** The task that gave up, so a surface can open it in the inspector. */
  task: string;
  /** `failed` is a fault; `needs_human` means the frame was drawn and review kept blocking it. */
  status: 'failed' | 'needs_human';
  /** The task's own `error`. Absent when it reached a terminal state without recording one. */
  error?: string;
  /** Attempt records carrying an error — the same records the retry budget counts. */
  attempts: number;
  /** `config.max_task_attempts`, the budget those attempts are counted against. */
  maxAttempts: number;
  /**
   * The task that gave up is a re-render rather than the one these bytes came from. The picture
   * on screen is the last one that worked, and the project has described it differently since.
   */
  later: boolean;
}

/** Everything the asset editor draws: what the bytes are, what made them, and what to edit. */
export interface AssetInfo {
  hash: string;
  ext: string;
  kind: AssetKind;
  /** Display name from `labelAssets` — the same words the document tree shows. */
  label: string;
  /** Routed to the base root — see `isBaseKind`, which is the one place that is decided. */
  base: boolean;
  accepted: boolean;
  /** The task that produced it; empty when the manifest records none. */
  sourceTask: string;
  /** The prompt recorded with the bytes, if the manifest kept one. */
  prompt?: string;
  /**
   * The authored name, for the one kind that has one. A concept is requested in a sentence and
   * keeps that sentence as its name. Every other kind is named after what it serves, so its label
   * is derived and this field is absent.
   */
  title?: string;
  /** The prompt the builders would write today; absent when the project no longer describes it. */
  derived?: string;
  /**
   * The bytes were rendered from words the project has since changed — what an art-notes edit
   * produces. False when `derived` is unknown: a missing derivation is not evidence of drift.
   * The `Corrections:` clause a P7 refine attempt appends is stripped before the comparison, so a
   * refined frame is not stale on account of the refine.
   */
  stale: boolean;
  /**
   * A reference this was drawn from has moved, or something it references is itself suspended
   * (§13). Derived on every read, never stored. The value is the sentence the pane shows: the
   * pane offers re-approve or regenerate rather than deciding for the author.
   */
  suspended?: string;
  /**
   * The picture this asset is, as a slot address — `plate:cafe/night`, `shot:greet/s2`. Absent
   * when nothing plans these bytes (a concept, an upload) and absent once a later render has taken
   * the slot over: it names what these bytes fill now, not what they were once drawn for.
   */
  slot?: string;
  /**
   * The pictures these bytes were drawn from, in the order the task fed them to the model — the
   * approval frontier, and what the pane's DRAWN FROM strip lists. Always present, empty for an
   * asset drawn from nothing, so no surface has to branch on `undefined`.
   */
  prereqs: Prereq[];
  /**
   * Why Approve is disabled: something upstream is not approved yet. The same sentence
   * `asset.accept` refuses with, so a greyed button's tooltip is the command's own word.
   */
  unapproved?: string;
  /**
   * Why the picture this asset fills is not finished. Read from the slot's identity as the project
   * states it today, so a re-render that failed after these bytes were drawn is reported too.
   * Absent while that identity is pending, running or done.
   */
  failure?: AssetFailure;
  /** The art-notes rungs that reach this asset, widest first. */
  rungs: ArtRungInfo[];
  /**
   * The project-wide seed from `project.yaml`, which every rung falls back to. Shown as the
   * placeholder in an empty seed box, so "inherits" says what it inherits.
   */
  configSeed?: number;
  /**
   * The composed prompt: the clauses, what the override does to them, and the string that would
   * be sent. Folded in here so the pane makes one round trip and there is one invalidation path.
   * Named apart from `prompt`, which is the historical record the manifest kept; this field is
   * what would be sent now. The two may disagree by the `Corrections:` clause of a refine attempt
   * with `stale` false, because that clause is stripped before staleness is decided.
   */
  promptView?: PromptView;
}

/**
 * What the Project editor draws: `project.yaml` as the app reads it, plus the one number that
 * makes the art style consequential. Only `artStyle` is editable — everything else is shown so
 * the author can see what the run is configured with without leaving the shell.
 *
 * `keys` is deliberately left out. Those are env-var names and safe to print, but a settings pane
 * that lists them is one screenshot away from looking like it lists their values.
 */
export interface ProjectView {
  root: string;
  title: string;
  artStyle: string;
  start: string;
  models: { image: string; text: string; vision: string[] };
  imageParams: { aspect: string; seed?: number };
  /**
   * How many image tasks the graph holds. The art style is the first clause of every image prompt,
   * so this is exactly how many task hashes change when it does — what `project.setArtStyle`
   * confirms against.
   */
  imageTasks: number;
}

/** The two places `project.setKey` can write a key. Keys also resolve from an env var and from
 *  the enclosing repo's `keys/`, but those sources are only reported, never written. */
export type KeyScope = 'project' | 'user';

/**
 * What the Setup pane knows about one vendor's key. Never the key — `keyStatus` reports which
 * source answered and nothing else, which is what makes this safe to send to a renderer.
 */
export interface VendorKeyView {
  vendor: string;
  /** Whether a key resolved at all. */
  resolved: boolean;
  /** Where it came from, as a sentence: an env var by name, or a directory and a file. */
  source: string;
  /** The environment variable `project.yaml` names for this vendor. */
  envName: string;
  /**
   * Whether that variable is set. It is read before every file, so a set variable shadows a key
   * the author has just pasted — the pane says so rather than leaving them to guess.
   */
  envShadow: boolean;
  /** Where `project.setKey` would put a key at each scope. Absolute for `user`, relative for the
   *  project, because one is in the workspace and the other deliberately is not. */
  writesTo: Record<KeyScope, string>;
}

/** What the Setup pane draws: one row per vendor, in `KEY_VENDORS` order. */
export interface KeyStatusView {
  vendors: VendorKeyView[];
  /** The user-level `keys/` directory, so the pane can name it once rather than per vendor. */
  userKeysDir: string;
}

/**
 * The sidebar's default view: five branches plus the backlinks behind them. Both come from one
 * walk — the scene → shot tree and "which shots is Aiko in" read the same storyboards — so they
 * travel as one shape.
 */
export interface DocTree {
  roots: DocNode[];
  /**
   * Keyed by node id (`character:aiko`, `location:gate`, `scene:arrival`), so a panel finds its
   * subject's links by lookup rather than through a second key convention.
   */
  backlinks: Record<string, EntityLinks>;
  /**
   * Workspace-relative document path → the backlink key for the subject that file holds. The
   * inverse of the key convention, so a surface holding only a path — an open editor knows its
   * document and nothing else — need not re-derive one. A file that is not a subject is absent.
   */
  pathIndex: Record<string, string>;
}

/**
 * What `doc.read` hands back. Re-exported rather than restated: the reader owns the shape, and
 * restating it here would let the two copies drift until a hash no longer meant the same thing
 * at both ends.
 */
export type { DocFile } from '@vn/store';

/**
 * Outcome of a whole-document save. `diagnostic` is the one thing here that is not an error: the
 * file is on disk and the front-matter parsed, but it does not satisfy the entity schema — an
 * author mid-thought must not be trapped by a half-typed field, so the editor shows the sentence
 * and the save stands.
 */
export interface DocSaveResult {
  /** Workspace-relative, `/` separators. */
  path: string;
  /** The hash the editor now holds, and presents on its next save. */
  hash: string;
  bytes: number;
  diagnostic?: string;
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
 * change which scenes exist (a split adds a chunk, a delete or a merge removes one) so what
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
  /** The files under `.aiagent/skills`, which the document tree deliberately does not carry. */
  'workspace:skilltree': () => DocNode[];
  'agent:run': (userInput: string) => RunResult;
  'agent:setMode': (mode: AgentMode) => AgentMode;
  'agent:setModel': (modelId: string) => string;
  'agent:clear': () => void;
  /**
   * The system prompt as the next turn will send it, in its sections. Rebuilt from the project
   * on every call rather than read off a live agent, because that is exactly what `runAgent`
   * does before each turn — so the answer is the same one whether or not the agent has started.
   */
  'agent:system': () => AgentSystem;
  'plan:decision': (payload: { id: number; decision: PlanDecision }) => void;
  /**
   * The author's answers to `permission:ask`, one per question and in the form's own order. An
   * empty string is a deliberate answer, not a missing one.
   */
  'ask:answer': (payload: { id: number; answers: string[] }) => void;
  /** Yes or no to `permission:confirm`. A window that closes before answering counts as no. */
  'confirm:decision': (payload: { id: number; allowed: boolean }) => void;
  'pipeline:status': () => PipelineStatus;
  'pipeline:run': (opts: { mock: boolean }) => PipelineRunResult;
  'gate:candidates': (characterId: string) => GateCandidate[];
  'gate:approve': (payload: { characterId: string; hash: string }) => ApproveResult;
  /** Build the playable (`story.play.json` shape) live from the loaded model + store. */
  'story:play': () => Playable;
  /**
   * The branch structure for the editor. A read, so it gets a typed channel; every branch
   * mutation goes through a `story.*` command instead, for one provenance record per act.
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
   * Reports whether an invocation would run. A read, never a gate — `command:exec` re-decides
   * for itself. `undeclared` is the answer for a command that states no precondition.
   */
  'command:check': (request: { id: string; props?: Record<string, PropValue> }) => CommandCheck;
  /** Restores a snapshot; refuses (never guesses) if the workspace moved — see `@vn/commands`. */
  'command:undo': () => CommandOutcome;
  'command:redo': () => CommandOutcome;
  /** Persist one piece of UI state; the initial read is the synchronous preload snapshot. */
  'session:set': (payload: { key: string; value: SessionValue }) => void;
  /**
   * Every notification the project holds, oldest first, already deduped across a union merge.
   * A read; every change to one goes through a `notify.*` command like any other mutation.
   */
  'notify:list': () => Notification[];
  /**
   * File a notification the renderer raised on its own — the handful of notices that are not a
   * command's outcome, which main would otherwise never hear about.
   */
  'notify:post': (input: NotificationInput) => Notification;
}

/**
 * One labelled part of the system prompt. The parts travel separately because that is how they
 * are cached and superseded, and because a reader wants to know which of the three said a thing —
 * the built-in contract, the generated project map, or the author's own `AICONTEXT.md`.
 */
export interface SystemSectionView {
  name: string;
  text: string;
}

/** The final system prompt, plus where the author-supplied half of it came from. */
export interface AgentSystem {
  sections: SystemSectionView[];
  /** Absolute paths of every context file that contributed, in load order. */
  files: string[];
  /** The text model the sections would be sent to. */
  modelId: string;
}

/** Events pushed from main to the renderer (fire-and-forget). */
export interface EventChannels {
  'agent:event': AgentEvent;
  'permission:plan': PlanRequest;
  'permission:ask': AskRequest;
  'permission:confirm': ConfirmRequest;
  'command:ui': UiEffect;
  /**
   * One notification was posted, or one's flags changed. Carries the notification when it is new
   * and nothing when a flag moved — the dialog refetches either way, and the bell only needs to
   * know that its count is stale.
   */
  'notify:changed': { note?: Notification };
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
