import type { AnyTask, Logger, ProjectModel, Providers, TaskGraph, TaskKind } from '@vn/types';
import type { AssetStore } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { GraphRuntime } from './graphrun.js';

/**
 * Everything a runner needs to execute one task (report §5, §8). This is not the graph: the
 * scheduler owns the graph and status transitions, and a runner only produces an asset from a
 * fully-specified task. `now` supplies timestamps because runner code must stay deterministic
 * where possible, so the caller injects the clock.
 */
export interface RunDeps {
  model: ProjectModel;
  store: AssetStore;
  providers: Providers;
  logger?: Logger;
  /** Injected clock for provenance stamps (ISO string). */
  now?: () => string;
  /**
   * The generation graphs the host has loaded, and the services they run against. A task
   * whose slot no graph binds runs the same code it did before graphs existed, so a project
   * with no graphs never reaches this.
   */
  graphs?: GraphRuntime;
}

/** A dry-run estimate of the generative work a plan implies (report §10 cost preview). */
export interface CostPreview {
  /** Image generation/edit calls. */
  imageCalls: number;
  /** Vision-review calls. */
  reviewCalls: number;
  /** Count of pending tasks by kind. */
  byKind: Record<TaskKind, number>;
  /** Pending tasks counted (status `pending`). */
  pendingTasks: number;
  /**
   * Pending tasks a generation graph draws. Their calls are left out of `imageCalls` and
   * `reviewCalls`, because what a graph spends is counted node by node rather than per task.
   */
  boundTasks: number;
}

const ZERO_BY_KIND = (): Record<TaskKind, number> => ({
  location_ref : 0,
  portrait     : 0,
  model_sheet  : 0,
  outfit_sheet : 0,
  shot_image   : 0,
  vision_review: 0,
  prompt_refine: 0,
});

/**
 * Estimate the generative cost of the pending tasks in a graph (report §10). A single image
 * task is one call; a shot task is the P7 worst case — up to `max_refine_attempts` image
 * calls, each critiqued by every configured reviewer. This is the upper bound shown before
 * spending money; the actual run usually costs less because most shots pass on attempt one.
 *
 * `drawnByGraph` names the tasks a generation graph draws. Those are still counted as pending
 * work, but they contribute no calls: the graph's own estimate prices them node by node, and
 * counting both would charge for each of them twice.
 */
export function costPreview(
  graph: TaskGraph,
  config: ProjectConfig,
  drawnByGraph?: (task: AnyTask) => boolean,
): CostPreview {
  const byKind = ZERO_BY_KIND();
  let imageCalls = 0;
  let reviewCalls = 0;
  let pendingTasks = 0;
  let boundTasks = 0;
  const reviewers = config.models.vision.length;
  const maxAttempts = Math.max(1, config.max_refine_attempts);

  for (const task of graph.all()) {
    if (task.status !== 'pending') continue;
    pendingTasks += 1;
    byKind[task.kind] += 1;
    if (drawnByGraph?.(task) === true) {
      boundTasks += 1;
      continue;
    }
    if (task.kind === 'shot_image') {
      imageCalls += maxAttempts;
      reviewCalls += maxAttempts * reviewers;
    } else if (
      task.kind === 'location_ref' ||
      task.kind === 'portrait' ||
      task.kind === 'model_sheet' ||
      task.kind === 'outfit_sheet'
    ) {
      imageCalls += 1;
    }
  }

  return { imageCalls, reviewCalls, byKind, pendingTasks, boundTasks };
}

/** Pending tasks in the graph, in topological order (what a run would execute). */
export function pendingInOrder(graph: TaskGraph): AnyTask[] {
  const byHash = new Map(graph.all().map((t) => [t.hash, t] as const));
  return graph
    .topoOrder()
    .map((h) => byHash.get(h))
    .filter((t): t is AnyTask => !!t && t.status === 'pending');
}
