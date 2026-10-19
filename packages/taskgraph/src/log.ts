import type { AnyTask } from '@vn/types';
import { appendJsonl, readJsonl } from '@vn/util';
import type { ProjectPaths } from '@vn/store';
import { TaskGraph } from './graph.js';

/**
 * Append-only task status log (report §7, §10). Every status transition writes a full
 * task snapshot line to `state/tasks.jsonl`; replaying the log (last-writer-wins per
 * hash) reconstructs the graph, which is what makes runs crash-safe and resumable.
 */

/**
 * One line of the log. `removed` marks a tombstone, which takes the task out of the replayed
 * graph until a later record for the same hash supersedes it. `restored` stamps a record put back
 * after a tombstone, a copy of the one the tombstone replaced.
 */
export type TaskRecord = AnyTask & { removed?: true; restored?: string };

/** Append a task's current state as one JSONL record. */
export async function logTask(paths: ProjectPaths, task: AnyTask): Promise<void> {
  await appendJsonl(paths.tasksLog, task);
}

/**
 * Append a tombstone for a task: its record put back to `pending` with no output or error, plus
 * `removed: true`. That is the requeue's shape, so a build that predates tombstones replays it
 * as a requeued task, with its `deps`, rather than as a record it cannot order.
 */
export async function logTombstone(paths: ProjectPaths, task: AnyTask): Promise<void> {
  await appendJsonl(paths.tasksLog, tombstoneOf(task));
}

/** Builds the record {@link logTombstone} appends for `task`, as it reads back from the log. */
export function tombstoneOf(task: AnyTask): TaskRecord {
  const record: TaskRecord = { ...task, status: 'pending', removed: true };
  delete record.output;
  delete record.error;
  return record;
}

/** Reads the last record per hash, tombstones included. A missing log has none. */
export async function latestRecords(paths: ProjectPaths): Promise<Map<string, TaskRecord>> {
  const latest = new Map<string, TaskRecord>();
  for (const record of await readJsonl<TaskRecord>(paths.tasksLog)) latest.set(record.hash, record);
  return latest;
}

/**
 * Puts back each task a tombstone took out whose last `done` record produced `output`: appends a
 * copy of that record stamped `restored`, and answers the copies. A task whose latest record is
 * not a tombstone is left alone.
 */
export async function restoreDone(
  paths: ProjectPaths,
  output: string,
  now = new Date(),
): Promise<TaskRecord[]> {
  const latest = new Map<string, TaskRecord>();
  const done = new Map<string, TaskRecord>();
  for (const record of await readJsonl<TaskRecord>(paths.tasksLog)) {
    latest.set(record.hash, record);
    if (record.status === 'done' && record.output === output) done.set(record.hash, record);
  }
  const restored: TaskRecord[] = [];
  for (const [hash, record] of done) {
    if (latest.get(hash)?.removed !== true) continue;
    const copy: TaskRecord = { ...record, restored: now.toISOString() };
    delete copy.removed;
    await appendJsonl(paths.tasksLog, copy);
    restored.push(copy);
  }
  return restored;
}

/**
 * Rebuild a TaskGraph by replaying the status log. A missing log gives an empty graph, and a
 * hash whose last record is a tombstone is left out.
 */
export async function loadGraph(paths: ProjectPaths): Promise<TaskGraph> {
  const graph = new TaskGraph();
  for (const task of (await latestRecords(paths)).values()) {
    if (task.removed !== true) graph.add(task);
  }
  return graph;
}
