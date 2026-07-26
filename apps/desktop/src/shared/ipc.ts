/**
 * The single source of truth for the renderer ↔ main IPC contract. Both the preload bridge
 * and the React renderer import these names + payload shapes, so a channel can't drift
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
  DefectReport,
  Diagnostic,
  Playable,
  Task as PipelineTask,
  TaskAttempt as PipelineTaskAttempt,
} from '@vn/types';
import type {
  CommandCatalog,
  CommandOutcome,
  CommandRecord,
  CommandSource,
  PropValue,
} from '@vn/commands';

export type {
  CommandCatalog,
  CommandOutcome,
  CommandRecord,
  CommandSource,
  PropValue,
} from '@vn/commands';

/** The rooms the shell can show; `view.room` targets one. */
export type Room = 'studio' | 'floor' | 'play';

/**
 * Which surface STUDIO shows in its main column: the vnauthor conversation, or the branch
 * editor. A mode rather than a fourth room — the composer stays put underneath either one, so
 * you can wire two scenes and then ask the agent to write what goes between them.
 */
export type StudioMode = 'convo' | 'branches';

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
  | { type: 'room'; name: Room }
  | { type: 'palette'; open: boolean }
  /** `room` is carried even though only STUDIO has modes, so adding a second one is additive. */
  | { type: 'mode'; room: Room; mode: StudioMode };

/** Either form of invocation accepted over `command:exec`: structured, or a DSL string. */
export interface CommandExecRequest {
  id?: string;
  props?: Record<string, PropValue>;
  dsl?: string;
  source?: CommandSource;
}

export type {
  AgentEvent,
  AgentMode,
  Plan,
  PlanDecision,
  RunResult,
  WorkspaceIndex,
} from '@vn/authoring';
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
 * Channels invoked by the renderer and answered by main (request → response).
 * Keep the key as the literal channel string; the value types the (args) → result.
 */
export interface InvokeChannels {
  'workspace:index': () => WorkspaceIndex;
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
  /** The live registry projection — never the generated file, so the two can't diverge. */
  'command:catalog': () => CommandCatalog;
  'command:exec': (request: CommandExecRequest) => CommandOutcome;
  'command:history': (limit?: number) => CommandRecord[];
  /** v1 always refuses, pointing at `docs/gitUndoOptions.md` — see `@vn/commands`. */
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
  /** A session key changed — either by this window or by a command like `view.panelSize`. */
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
 * (`vn.exec("view.room(name='floor')")`) or an id plus a props object.
 */
export interface CommandBridge {
  exec(dslOrId: string, props?: Record<string, PropValue>): Promise<CommandOutcome>;
  catalog(): Promise<CommandCatalog>;
  history(limit?: number): Promise<CommandRecord[]>;
  undo(): Promise<CommandOutcome>;
  redo(): Promise<CommandOutcome>;
}
