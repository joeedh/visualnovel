/**
 * The task model (report §7). A Task is a unit of generative work whose identity is
 * a content hash of everything that determines its output — this is what gives the
 * pipeline dedupe, resumability, and staleness/invalidation for free.
 */
import type { AssetRef, ImageParams, TakeVia } from './assets.js';

/** The kinds the registered families declare: one per entry of {@link TaskInputs}. */
export type TaskKind = keyof TaskInputs;

/**
 * Kinds the task union once named that nothing ever planned. An older `tasks.jsonl` may hold a
 * record of one; it loads, and no executor runs it.
 */
export type RetiredTaskKind = 'outfit_sheet' | 'vision_review' | 'prompt_refine';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'needs_human';

/**
 * Per-kind, fully-specified inputs, for the four kinds the stills family declares. Everything here
 * is folded into the task hash. A family in another package adds its kinds by augmenting this
 * interface (`declare module '@vn/types'`), which widens {@link TaskKind} with them.
 */
export interface TaskInputs {
  location_ref: {
    locationId: string;
    variant: string;
    prompt: string;
    refs: AssetRef[];
    params: ImageParams;
  };
  portrait: { characterId: string; prompt: string; refs: AssetRef[]; params: ImageParams };
  model_sheet: {
    characterId: string;
    outfit: string;
    angle: string;
    prompt: string;
    refs: AssetRef[];
    params: ImageParams;
  };
  shot_image: { shotId: string; prompt: string; refs: AssetRef[]; params: ImageParams };
}

/** A single execution attempt, recorded for provenance (report §P7). */
export interface TaskAttempt {
  attempt: number;
  prompt?: string;
  refs: string[];
  /** Asset hash produced this attempt, if any. */
  output?: string;
  /** Structured review verdicts gathered this attempt. */
  reviews?: unknown[];
  error?: string;
  /** ISO timestamp; stamped by the caller (scripts have no clock). */
  at?: string;
  /**
   * How this attempt's output entered its slot, for an attempt written outside a run. A restore
   * is recorded here rather than on the row, whose `via` keeps the picture's origin.
   */
  via?: TakeVia | 'restore';
}

/** A node in the task graph. Identity == `hash`. */
export interface Task<K extends TaskKind = TaskKind> {
  hash: string;
  kind: K;
  /** Upstream task hashes (DAG edges). */
  deps: string[];
  inputs: TaskInputs[K];
  status: TaskStatus;
  /** Asset hash when done. */
  output?: string;
  /** Why the task reached a terminal non-`done` state (`failed` or `needs_human`). */
  error?: string;
  attempts: TaskAttempt[];
  /** Response journal retained while an interrupted execution can be resumed. */
  checkpoint?: { id: string; records: number[]; signature: string };
  /** An execution stopped before reaching a terminal state. */
  interrupted?: boolean;
}

/** A loosely-typed task usable in heterogeneous collections. */
export type AnyTask = Task<TaskKind>;
