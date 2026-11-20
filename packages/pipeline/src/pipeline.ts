import type {
  AnyTask,
  Logger,
  ProjectModel,
  Providers,
  RetiredTaskKind,
  TaskGraph,
  TaskKind,
} from '@vn/types';
import type { AssetStore } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { TaskLogSink } from '@vn/providers';
import type { GraphRuntime } from './graphrun.js';
import type { TaskRequests } from './requests.js';
import { costOf, EXECUTORS } from './executors.js';

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
  /**
   * Hears what a task is doing while it runs — which attempt it is on, whether it is drawing or
   * reviewing, a retry it is waiting out. Each call replaces the last sentence for that task.
   */
  activity?: (task: AnyTask, doing: string) => void;
  /** Successful API answers for this execution, retained across cooperative stops. */
  requests?: TaskRequests;
  /** Persists attempt records before another request can start. */
  checkpoint?: (task: AnyTask) => Promise<void>;
  /** This execution's diagnostic log; provider calls beneath the runner reach it ambiently. */
  taskLog?: TaskLogSink;
}

/** A dry-run estimate of the generative work a plan implies (report §10 cost preview). */
export interface CostPreview {
  /** Image generation/edit calls. */
  imageCalls: number;
  /** Vision-review calls. */
  reviewCalls: number;
  /** Count of pending tasks by kind; a retired kind appears only when a pending record has it. */
  byKind: Record<TaskKind, number> & Partial<Record<RetiredTaskKind, number>>;
  /** Pending tasks counted (status `pending`). */
  pendingTasks: number;
  /**
   * Pending tasks a generation graph draws. Their calls are left out of `imageCalls` and
   * `reviewCalls`, because what a graph spends is counted node by node rather than per task.
   */
  boundTasks: number;
}

/**
 * Estimate the generative cost of the pending tasks in a graph (report §10), at each kind's cost
 * line in the executor registry. This is the upper bound shown before spending money; the actual
 * run usually costs less because most shots pass on attempt one.
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
  const counts: Record<string, number> = {};
  for (const kind of Object.keys(EXECUTORS)) counts[kind] = 0;
  let imageCalls = 0;
  let reviewCalls = 0;
  let pendingTasks = 0;
  let boundTasks = 0;

  for (const task of graph.all()) {
    if (task.status !== 'pending') continue;
    pendingTasks += 1;
    counts[task.kind] = (counts[task.kind] ?? 0) + 1;
    if (drawnByGraph?.(task) === true) {
      boundTasks += 1;
      continue;
    }
    const calls = costOf(task.kind, config);
    imageCalls += calls.image;
    reviewCalls += calls.review;
  }

  const byKind = counts as CostPreview['byKind'];
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
