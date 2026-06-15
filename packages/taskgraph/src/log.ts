import type { AnyTask } from '@vn/types';
import { appendJsonl, readJsonl } from '@vn/util';
import type { ProjectPaths } from '@vn/store';
import { TaskGraph } from './graph.js';

/**
 * Append-only task status log (report §7, §10). Every status transition writes a full
 * task snapshot line to `state/tasks.jsonl`; replaying the log (last-writer-wins per
 * hash) reconstructs the graph, which is what makes runs crash-safe and resumable.
 */

/** Append a task's current state as one JSONL record. */
export async function logTask(paths: ProjectPaths, task: AnyTask): Promise<void> {
  await appendJsonl(paths.tasksLog, task);
}

/** Rebuild a TaskGraph by replaying the status log; missing log → empty graph. */
export async function loadGraph(paths: ProjectPaths): Promise<TaskGraph> {
  const records = await readJsonl<AnyTask>(paths.tasksLog);
  const latest = new Map<string, AnyTask>();
  for (const record of records) latest.set(record.hash, record);
  const graph = new TaskGraph();
  for (const task of latest.values()) graph.add(task);
  return graph;
}
