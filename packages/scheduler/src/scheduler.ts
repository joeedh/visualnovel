import type { AnyTask, Logger, ProjectModel, Providers, TaskKind } from '@vn/types';
import type { AssetStore } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { ProjectPaths } from '@vn/store';
import { TaskGraph, logTask } from '@vn/taskgraph';
import { pool } from '@vn/util';
import {
  createRunners,
  costPreview,
  gateStatus,
  planTasks,
  runTask,
  type CostPreview,
  type GateStatus,
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
  const { model, graph, store, providers, config, paths, logger, now, dryRun } = opts;
  const deps: RunDeps = { model, store, providers, logger, now };
  const runners: Record<TaskKind, Runner> = createRunners(config);
  const ran: AnyTask[] = [];

  // Always (re)plan first so the preview and gate reflect the current model state. A dry run
  // may read persisted shots but must not write a mock decomposition a real run would reuse.
  await planTasks({ model, graph, config, providers, paths, logger, readOnlyShots: dryRun });

  if (dryRun) {
    return {
      ran,
      preview: costPreview(graph, config),
      gate: gateStatus(model),
      blockedOnGate: !gateStatus(model).cleared,
    };
  }

  // Plan → run ready wave → replan, until no task is ready.
  for (;;) {
    await planTasks({ model, graph, config, providers, paths, logger });
    const ready = graph.ready();
    if (ready.length === 0) break;

    await pool(ready, config.concurrency, async (task) => {
      graph.setStatus(task.hash, 'running');
      await logTask(paths, graph.get(task.hash)!);
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

      graph.setStatus(task.hash, result.status, { output: result.output });
      const finished = graph.get(task.hash)!;
      await logTask(paths, finished);
      ran.push(finished);
      logger?.[result.status === 'failed' ? 'error' : 'info']('task.end', {
        hash: task.hash,
        kind: task.kind,
        status: result.status,
        error: result.error,
      });
    });
  }

  const gate = gateStatus(model);
  return {
    ran,
    preview: costPreview(graph, config),
    gate,
    // The run halts at the gate when characters used by reachable scenes await approval.
    blockedOnGate: !gate.cleared,
  };
}
