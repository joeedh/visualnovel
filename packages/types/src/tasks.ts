/**
 * The task model (report §7). A Task is a unit of generative work whose identity is
 * a content hash of everything that determines its output — this is what gives the
 * pipeline dedupe, resumability, and staleness/invalidation for free.
 */
import type { AssetRef, ImageParams } from './entities.js';

export type TaskKind =
  | 'location_ref'
  | 'portrait'
  | 'model_sheet'
  | 'outfit_sheet'
  | 'shot_image'
  | 'vision_review'
  | 'prompt_refine';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'needs_human';

/** Per-kind, fully-specified inputs. Everything here is folded into the task hash. */
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
  outfit_sheet: {
    characterId: string;
    outfit: string;
    angle: string;
    prompt: string;
    refs: AssetRef[];
    params: ImageParams;
  };
  shot_image: { shotId: string; prompt: string; refs: AssetRef[]; params: ImageParams };
  vision_review: { target: string; spec: string; refs: AssetRef[]; modelId: string };
  prompt_refine: { basePrompt: string; defects: string; modelId: string };
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
}

/** A loosely-typed task usable in heterogeneous collections. */
export type AnyTask = Task<TaskKind>;
