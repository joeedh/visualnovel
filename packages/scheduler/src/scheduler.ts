import type { AnyTask, Logger, ProjectModel, Providers, TaskKind, TaskStatus } from '@vn/types';
import type { AssetStore, BaseAssets } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { ProjectPaths } from '@vn/store';
import { TaskGraph, logTask } from '@vn/taskgraph';
import { pool } from '@vn/util';
import {
  baseRefusal,
  boundGraph,
  createRunners,
  costPreview,
  driftedTasks,
  gateStatus,
  planTasks,
  runTask,
  type CostPreview,
  type GateStatus,
  type GraphRuntime,
  type RunDeps,
  type Runner,
} from '@vn/pipeline';

/** Inputs to a scheduler run (report §7, §10). */
export interface RunOptions {
  model: ProjectModel;
  graph: TaskGraph;
  store: AssetStore;
  providers: Providers;
  config: ProjectConfig;
  paths: ProjectPaths;
  logger?: Logger;
  /** Injected clock for provenance stamps. */
  now?: () => string;
  /** Plan + preview only; never spend on generation. */
  dryRun?: boolean;
  /**
   * Called as the run makes progress. A run is otherwise one blocking round trip, so a surface
   * showing how much work is left cannot be built from the return value: by the time the caller
   * holds that value, there is nothing left to report.
   */
  onProgress?: (progress: RunProgress) => void;
  /**
   * Stop the run. Checked between waves and before a task starts, never during one: a runner
   * interrupted mid-call would leave a `running` node and a half-written attempt, and the log
   * of those transitions is what makes a run resumable.
   */
  signal?: AbortSignal;
  /**
   * The generation graphs the host has loaded, indexed by the slot each active output binds
   * to. A task whose slot no graph names runs the code it ran before graphs existed.
   */
  graphs?: GraphRuntime;
}

/** Where a run has got to, as {@link RunOptions.onProgress} sees it. */
export interface RunProgress {
  /** Tasks that reached a terminal state this run. */
  ran: number;
  /** Tasks the last planning pass asked for that are not finished — including those in flight. */
  pending: number;
  /** Tasks in flight at this moment. */
  running: number;
}

/** Outcome of a scheduler run. */
export interface RunSummary {
  /** Tasks that transitioned to a terminal state this run. */
  ran: AnyTask[];
  /** Cost preview computed against the planned graph. */
  preview: CostPreview;
  /** Character-approval gate state after planning. */
  gate: GateStatus;
  /** True when the run halted because the only remaining work is behind the gate. */
  blockedOnGate: boolean;
  /** Hashes of `failed` tasks this run put back to `pending` before the wave loop. */
  retried: string[];
  /**
   * Hashes of tasks this run put back to `pending` because the generation graph bound to
   * their slot has been edited since it drew them.
   */
  redrawn: string[];
  /**
   * Tasks the current plan wants that are `failed` — including failures inherited from an
   * earlier run, which `ran` cannot see. Intersected with the last planning pass, because
   * `tasks.jsonl` is never pruned and an orphan must not make a run report a failure forever.
   */
  failed: AnyTask[];
  /** Tasks the current plan wants that are `needs_human`, on the same basis as {@link failed}. */
  needsHuman: AnyTask[];
  /** The store's base asset root, when it has one — so a surface can report counts and state. */
  base?: BaseAssets;
  /**
   * Set when the run planned nothing on purpose, with the sentence saying why. Today the only
   * reason is an unavailable base root; a run reporting one did no work and could not.
   */
  refused?: string;
  /**
   * True when the run stopped because it was asked to rather than because nothing was left
   * ready. Everything it did finish is recorded, so the next run resumes from there.
   */
  stopped?: boolean;
}

/**
 * Put `failed` tasks back to `pending` so the next run retries them — a failure is usually a
 * transient provider error, and without this a node is terminal for the life of the project.
 *
 * Two bounds keep that from being reckless. `plannedHashes` is the live set the current plan
 * asked for: `tasks.jsonl` is never pruned, so a project whose prompts changed carries orphaned
 * `failed` nodes forever, and requeueing one spends real money on a frame nothing wants. The
 * budget counts attempt records that carry an `error` rather than `attempts.length`, because a
 * `needs_human` shot has one attempt per P7 refine pass, which is not a retry of anything.
 *
 * `needs_human` is never requeued: it is a request for a human, not a fault.
 */
export function requeueFailed(
  graph: TaskGraph,
  plannedHashes: ReadonlySet<string>,
  maxAttempts: number,
): AnyTask[] {
  const requeued: AnyTask[] = [];
  for (const task of graph.all()) {
    if (task.status !== 'failed' || !plannedHashes.has(task.hash)) continue;
    if (task.attempts.filter((a) => a.error).length >= maxAttempts) continue;
    graph.setStatus(task.hash, 'pending', { error: undefined });
    requeued.push(task);
  }
  return requeued;
}

/**
 * Put back to `pending` every task whose bound generation graph has been edited since it drew
 * the slot, so this run redraws it. Editing a graph does not move the task's hash, so without
 * this the `done` record keeps its picture for the life of the project and the edit shows up
 * only as a drift report.
 *
 * `plannedHashes` bounds it to what the current plan asked for, on the same reasoning as
 * {@link requeueFailed}. `failed` is left to that function and its attempt budget: a redraw
 * clears the drift by writing the graph's new hash into its journal, and a graph that fails
 * writes no such hash, so requeueing a failure here would ask for the same work on every run.
 */
export function requeueDrifted(
  taskGraph: TaskGraph,
  plannedHashes: ReadonlySet<string>,
  deps: RunDeps,
): AnyTask[] {
  const drawn = taskGraph
    .all()
    .filter(
      (t) => plannedHashes.has(t.hash) && (t.status === 'done' || t.status === 'needs_human'),
    );
  const requeued = driftedTasks(drawn, deps);
  for (const task of requeued) {
    taskGraph.setStatus(task.hash, 'pending', { output: undefined, error: undefined });
  }
  return requeued;
}

/** The reference hashes a task's inputs carry, if its kind has any (`prompt_refine` does not). */
function inputRefHashes(task: AnyTask): string[] {
  const refs = (task.inputs as { refs?: { hash: string }[] }).refs;
  return refs ? refs.map((r) => r.hash) : [];
}

/**
 * Drive the task graph to completion under a concurrency cap (report §7, §10). The loop is
 * deliberately plan-run-replan: each wave re-plans (so tasks whose identity depends on an
 * upstream output appear only once that output exists), then runs every currently-ready task
 * in parallel up to `config.concurrency`. Approval gates act as barriers — shot tasks simply
 * are not planned until their characters are approved, so the run naturally halts at the gate
 * with nothing left ready. Every status transition is appended to `tasks.jsonl`, which makes
 * the run crash-safe and resumable: re-running replays the log and skips `done` work.
 */
export async function runPipeline(opts: RunOptions): Promise<RunSummary> {
  const { model, graph, store, providers, config, paths, logger, now, dryRun, onProgress } = opts;
  const deps: RunDeps = { model, store, providers, logger, now, graphs: opts.graphs };
  // A task a graph draws is priced by the graph rather than by its own call count, so the
  // preview asks the same index the runner does.
  const drawnByGraph = (task: AnyTask): boolean => boundGraph(task, deps) !== undefined;
  const runners: Record<TaskKind, Runner> = createRunners(config);
  const ran: AnyTask[] = [];

  // Always (re)plan first so the preview and gate reflect the current model state. A dry run
  // may read persisted shots but must not write a mock decomposition a real run would reuse.
  const firstPass = await planTasks({
    model,
    graph,
    config,
    providers,
    paths,
    logger,
    base: store.base,
    readOnlyShots: dryRun,
  });

  // Refuse here rather than letting the loop find nothing ready: from the outside "nothing was
  // planned" and "nothing is left to do" look identical, and only one of them is a problem.
  const refused = baseRefusal(store.base);
  if (refused) {
    const gate = gateStatus(model);
    return {
      ran,
      preview: costPreview(graph, config, drawnByGraph),
      gate,
      blockedOnGate: false,
      retried: [],
      redrawn: [],
      failed: [],
      needsHuman: [],
      base: store.base,
      refused,
    };
  }

  // Once per run, before the loop. Requeueing inside it would re-run a task that just failed,
  // in the same process, against the same transient condition — and could spin.
  const requeued = requeueFailed(
    graph,
    new Set(firstPass.map((t) => t.hash)),
    config.max_task_attempts,
  );
  const retried = requeued.map((t) => t.hash);
  // A dry run requeues in memory so `cost` counts the retry it would perform, and writes
  // nothing: the divergence from the log dies with the process.
  if (!dryRun) for (const node of requeued) await logTask(paths, node);
  if (retried.length) logger?.info('task.retry', { hashes: retried });

  // After the retries, so a task both a failure and a graph edit want back is requeued once.
  const stale = requeueDrifted(graph, new Set(firstPass.map((t) => t.hash)), deps);
  const redrawn = stale.map((t) => t.hash);
  if (!dryRun) for (const node of stale) await logTask(paths, node);
  if (redrawn.length) logger?.info('task.redraw', { hashes: redrawn });

  // The live set is what the current plan asked for, deduped back to canonical nodes. Every
  // terminal-state report is derived from this rather than from what this process happened to
  // touch, so a failure inherited from an earlier run still counts and an orphan never does.
  const live = (planned: AnyTask[], status: TaskStatus): AnyTask[] =>
    [...new Set(planned.map((t) => t.hash))]
      .map((h) => graph.get(h)!)
      .filter((t) => t.status === status);
  let plannedNow = firstPass;

  if (dryRun) {
    const gate = gateStatus(model);
    return {
      ran,
      preview: costPreview(graph, config, drawnByGraph),
      gate,
      blockedOnGate: !gate.cleared,
      retried,
      redrawn,
      failed: live(plannedNow, 'failed'),
      needsHuman: live(plannedNow, 'needs_human'),
      base: store.base,
    };
  }

  // The unfinished half of what the current plan asked for. Derived from the plan rather than
  // from `graph.all()`, which carries orphans `tasks.jsonl` was never pruned of — a progress
  // count that included those would never reach zero.
  let planned = new Set(firstPass.map((t) => t.hash));
  let running = 0;
  const unfinished = () =>
    [...planned].filter((hash) => {
      const status = graph.get(hash)?.status;
      return status === 'pending' || status === 'running';
    }).length;
  const progress = () => onProgress?.({ ran: ran.length, pending: unfinished(), running });

  progress();

  // Plan → run ready wave → replan, until no task is ready or the run is asked to stop.
  let stopped = false;
  while (!opts.signal?.aborted) {
    plannedNow = await planTasks({
      model,
      graph,
      config,
      providers,
      paths,
      logger,
      base: store.base,
    });
    planned = new Set(plannedNow.map((t) => t.hash));
    const ready = graph.ready();
    if (ready.length === 0) break;
    progress();

    await pool(ready, config.concurrency, async (task) => {
      // The cap means most of a wave is still queued when a stop arrives, and this check refuses
      // the bulk of it, since `pool` has no way to drop a task it has not started.
      if (opts.signal?.aborted) {
        stopped = true;
        return;
      }
      running++;
      graph.setStatus(task.hash, 'running');
      await logTask(paths, graph.get(task.hash)!);
      // Reported at the start as well as the end. A host drawing what is in flight would
      // otherwise only ever hear about a task once it had stopped being in flight.
      progress();
      logger?.info('task.start', { hash: task.hash, kind: task.kind });

      let result;
      try {
        result = await runTask(task, deps, runners);
      } catch (err) {
        result = {
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // `error` is passed unconditionally: on `done` it is undefined, which overwrites any
      // stale reason from an earlier attempt and drops out of the logged JSON entirely.
      graph.setStatus(task.hash, result.status, {
        output: result.output,
        error: result.error,
      });
      const finished = graph.get(task.hash)!;
      // A runner that threw recorded nothing, so the failure would otherwise leave no trace in
      // the causal chain — and the cross-run retry budget counts exactly these records.
      if (result.status === 'failed') {
        finished.attempts.push({
          attempt: finished.attempts.length + 1,
          refs: inputRefHashes(finished),
          error: result.error,
          at: now?.(),
        });
      }
      await logTask(paths, finished);
      ran.push(finished);
      running--;
      progress();
      logger?.[result.status === 'failed' ? 'error' : 'info']('task.end', {
        hash: task.hash,
        kind: task.kind,
        status: result.status,
        error: result.error,
      });
    });
  }
  if (opts.signal?.aborted) stopped = true;
  progress();

  const gate = gateStatus(model);
  return {
    ran,
    preview: costPreview(graph, config, drawnByGraph),
    gate,
    // The run halts at the gate when characters used by reachable scenes await approval.
    blockedOnGate: !gate.cleared,
    retried,
    redrawn,
    failed: live(plannedNow, 'failed'),
    needsHuman: live(plannedNow, 'needs_human'),
    base: store.base,
    ...(stopped ? { stopped } : {}),
  };
}
