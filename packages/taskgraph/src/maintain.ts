/**
 * `@vn/taskgraph/maintain`: the task-log writers that tidy the log rather than record work. Each
 * writes a tombstone, a `pending` requeue, or a verbatim copy of a record the log already holds,
 * so none of them can claim work that never ran. Not re-exported from the barrel.
 */
import type { AnyTask } from '@vn/types';
import { appendJsonl, readJsonl } from '@vn/util';
import type { ProjectPaths } from '@vn/store';
import { tombstoneOf, type TaskRecord } from './log.js';

/**
 * Append a tombstone for a task: its record put back to `pending` with no output or error, plus
 * `removed: true`. That is the requeue's shape, so a build that predates tombstones replays it
 * as a requeued task, with its `deps`, rather than as a record it cannot order.
 */
export async function logTombstone(paths: ProjectPaths, task: AnyTask): Promise<void> {
  await appendJsonl(paths.tasksLog, tombstoneOf(task));
}

/**
 * Appends a copy of a record a tombstone replaced, stamped `restored` with `at` and without
 * `removed`, and answers the copy.
 */
export async function logRestored(
  paths: ProjectPaths,
  record: TaskRecord,
  at: string,
): Promise<TaskRecord> {
  const copy: TaskRecord = { ...record, restored: at };
  delete copy.removed;
  await appendJsonl(paths.tasksLog, copy);
  return copy;
}

/**
 * Appends a task put back to `pending`, with no output, error, checkpoint or interruption, so the
 * next run renders it again. `loadGraph` replays last-writer-wins, which is what makes this a
 * requeue.
 */
export async function logRequeue(paths: ProjectPaths, task: AnyTask): Promise<void> {
  await appendJsonl(paths.tasksLog, {
    ...task,
    status     : 'pending',
    output     : undefined,
    error      : undefined,
    checkpoint : undefined,
    interrupted: undefined,
  });
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
    restored.push(await logRestored(paths, record, now.toISOString()));
  }
  return restored;
}
