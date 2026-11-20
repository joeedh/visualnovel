import { contract } from '@vn/contracts';
import type { AnyTask } from '@vn/types';
import { readJsonl } from '@vn/util';
import type { ProjectPaths } from '@vn/store';
import { TaskGraph } from './graph.js';

/**
 * Append-only task status log (report §7, §10). Every status transition writes a full
 * task snapshot line to `state/tasks.jsonl`; replaying the log (last-writer-wins per
 * hash) reconstructs the graph, which is what makes runs crash-safe and resumable.
 *
 * This module only reads the log. The writers are subpath entries: `logTask` in
 * `@vn/taskgraph/write`, and the tombstone, restore and requeue writers in
 * `@vn/taskgraph/maintain`.
 */

export const logLastWriterWins = contract({
  id      : 'log.lastWriterWins',
  rule: 'Every status transition appends the whole task to `state/tasks.jsonl`, and replaying the log, last writer wins per hash, rebuilds the task graph.',
  prevents:
    'A crash, a stop or a restart losing which tasks finished, so that the next run pays again for pictures already drawn.',
  subjects: [
    'function:packages/taskgraph/src/log.ts#loadGraph',
    'function:packages/taskgraph/src/log.ts#latestRecords',
    'function:packages/taskgraph/src/write.ts#logTask',
    'file:state/tasks.jsonl',
  ],
  see: [
    'docs/history/vn-generator-report.md',
    'docs/plans/contracts-into-code-and-workflows.md#stage-8-execution-contracts',
  ],
  detail:
    '`logTask` (`@vn/taskgraph/write`) appends a whole-node snapshot rather than a change, so a ' +
    'field added to a task, such as `Task.error`, reaches the log without a format change. ' +
    '`loadGraph` keeps the last record per hash, and a missing log is an empty graph. A line that ' +
    'does not parse stops `readJsonl`, as any bad line does. Which writers may append which ' +
    'statuses is `log.doneWriters`, and how a record takes a task out of the graph is ' +
    '`log.tombstoneRemoves`.',
});

export const logTombstoneRemoves = contract({
  id      : 'log.tombstoneRemoves',
  rule: "A tombstone takes a task out of the replayed graph. It is a full copy of the task's last record with `status: 'pending'`, no `output`, no `error`, and `removed: true`, and a later record for the same hash supersedes it.",
  prevents:
    'A removed task still counted by `vngen status` and the Task Graph pane, or a build that predates tombstones throwing on a bare `{ hash, removed }` record that has no `deps`.',
  subjects: [
    'function:packages/taskgraph/src/maintain.ts#logTombstone',
    'function:packages/taskgraph/src/maintain.ts#restoreDone',
    'function:packages/taskgraph/src/log.ts#tombstoneOf',
    'function:packages/taskgraph/src/log.ts#loadGraph',
    'file:state/tasks.jsonl',
  ],
  see: [
    'docs/plans/archive/deleting-things.md#stage-2-tombstones-in-tasksjsonl',
    'docs/plans/contracts-into-code-and-workflows.md#stage-8-execution-contracts',
  ],
  detail:
    '`logTombstone` (`@vn/taskgraph/maintain`) appends the record `tombstoneOf` builds. ' +
    '`loadGraph` leaves a hash out when its last record is a tombstone, so `vngen status` and ' +
    'the Task Graph pane stop counting it. A later task record for the same hash supersedes the ' +
    'tombstone, and the planner plans the task again; `restoreDone` appends such a record, a ' +
    'copy of the `done` record the tombstone replaced, stamped `restored`. The shape is the ' +
    "requeue's plus one field, so a build that predates tombstones replays one as a requeued " +
    "task, with its `deps`. A bare `{ hash, removed }` record would reach that build's " +
    '`topoOrder` with no `deps` array, and it would throw. A line that does not parse still ' +
    'stops `readJsonl`, as any bad line does.',
});

/**
 * One line of the log. `removed` marks a tombstone, which takes the task out of the replayed
 * graph until a later record for the same hash supersedes it. `restored` stamps a record put back
 * after a tombstone, a copy of the one the tombstone replaced.
 */
export type TaskRecord = AnyTask & { removed?: true; restored?: string };

/** Builds the record `logTombstone` appends for `task`, as it reads back from the log. */
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
