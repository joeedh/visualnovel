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
import type { Playable, Task } from '@vn/types';

export type {
  AgentEvent,
  AgentMode,
  Plan,
  PlanDecision,
  RunResult,
  WorkspaceIndex,
} from '@vn/authoring';
export type { Playable, Beat, PlayableScene, Task, TaskKind, TaskStatus } from '@vn/types';

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
}

/** Events pushed from main to the renderer (fire-and-forget). */
export interface EventChannels {
  'agent:event': AgentEvent;
  'permission:plan': PlanRequest;
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
}
