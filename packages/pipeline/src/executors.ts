/**
 * The executor's registry, keyed by task kind: the runner that draws a task of each kind, and the
 * most calls one task of it spends. It lives in the host rather than on the solver's `SlotKind`,
 * because a runner reaches providers and generation graphs, which neither `@vn/constraint-solver`
 * nor `@vn/stills` may import.
 */
import type { AnyTask, TaskKind, TaskResult } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { noteTask, reportingRetries, withTaskLog } from '@vn/providers';
import type { RunDeps } from './pipeline.js';
import {
  makeShotRunner,
  runLocationRef,
  runModelSheet,
  runPortrait,
  type Runner,
} from './runners.js';

/** The most calls one task spends: every refine attempt drawn, and every reviewer asked. */
export interface Calls {
  image: number;
  review: number;
}

/** What the executor does with one task kind. */
export interface Executor<K extends TaskKind> {
  /** Builds the runner, bound to the project's config. */
  runner(config: ProjectConfig): Runner<K>;
  /** Answers the calls one pending task of the kind spends at most, before any graph draws it. */
  cost(config: ProjectConfig): Calls;
}

const oneImage = (): Calls => ({ image: 1, review: 0 });

const noCalls = (): Calls => ({ image: 0, review: 0 });

/** The P7 worst case: every refine attempt drawn, and each critiqued by every reviewer. */
function shotCost(config: ProjectConfig): Calls {
  const attempts = Math.max(1, config.max_refine_attempts);
  return { image: attempts, review: attempts * config.models.vision.length };
}

/** The kinds the stills family declares, each with its runner and its cost line. */
export const EXECUTORS: { readonly [K in Exclude<TaskKind, RetiredKind>]: Executor<K> } = {
  location_ref: { runner: () => runLocationRef, cost: oneImage },
  portrait    : { runner: () => runPortrait, cost: oneImage },
  model_sheet : { runner: () => runModelSheet, cost: oneImage },
  shot_image  : { runner: makeShotRunner, cost: shotCost },
};

/** Kinds the task union names that nothing has ever planned, so no executor takes them. */
type RetiredKind = 'outfit_sheet' | 'vision_review' | 'prompt_refine';

/**
 * The cost line each retired kind was priced at while it had a placeholder runner, so a log that
 * holds a pending record of one prices as it did. Running one fails without a call.
 */
const RETIRED_COST: { readonly [K in RetiredKind]: (config: ProjectConfig) => Calls } = {
  outfit_sheet : oneImage,
  vision_review: noCalls,
  prompt_refine: noCalls,
};

/** The registry's entry for a kind, or `undefined` for a kind no executor takes. */
export function executorOf(kind: string): Executor<TaskKind> | undefined {
  return Object.hasOwn(EXECUTORS, kind)
    ? (EXECUTORS[kind as keyof typeof EXECUTORS] as unknown as Executor<TaskKind>)
    : undefined;
}

/** Answers the most calls one pending task of `kind` spends; a kind nothing prices spends none. */
export function costOf(kind: string, config: ProjectConfig): Calls {
  const executor = executorOf(kind);
  if (executor) return executor.cost(config);
  return Object.hasOwn(RETIRED_COST, kind) ? RETIRED_COST[kind as RetiredKind](config) : noCalls();
}

/** Each registered kind's runner, bound to the project's config. */
export type Runners = ReadonlyMap<string, Runner>;

/** Builds every registered kind's runner, bound to the project config (for the P7 cap). */
export function createRunners(config: ProjectConfig): Runners {
  const runners = new Map<string, Runner>();
  for (const kind of Object.keys(EXECUTORS)) {
    runners.set(kind, executorOf(kind)!.runner(config) as Runner);
  }
  return runners;
}

/** The runner for a kind nothing registers, which fails the task and names its kind. */
const unsupported =
  (kind: string): Runner =>
  (task) =>
    Promise.resolve({
      status: 'failed',
      error : `no runner for task kind "${kind}" (${task.hash})`,
    });

/**
 * Dispatch a task to its kind's runner. A retry a provider call makes underneath is reported as
 * the task's activity, since the runner cannot see it and it is the wait an author most wants
 * explained.
 */
export async function runTask(task: AnyTask, deps: RunDeps, runners: Runners): Promise<TaskResult> {
  deps.activity?.(task, 'drawing');
  const runner = runners.get(task.kind) ?? unsupported(task.kind);
  const run = () =>
    runner(task, {
      ...deps,
      store    : deps.requests?.store(deps.store) ?? deps.store,
      providers: deps.requests?.providers(deps.providers) ?? deps.providers,
    });
  const { activity } = deps;
  const heard = (note: string): void => {
    activity?.(task, note);
    noteTask('retry', note);
  };
  try {
    return await withTaskLog(deps.taskLog, () => reportingRetries(heard, run));
  } finally {
    await deps.requests?.settled();
  }
}
