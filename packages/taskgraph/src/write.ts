/**
 * `@vn/taskgraph/write`: the one task-log writer that can append a record in any status, `done`
 * included. It is a subpath entry rather than part of the barrel, and `vn/element-types` lets only
 * the scheduler and adoption (`@vn/artgen/adopt`) import it.
 */
import type { AnyTask } from '@vn/types';
import { appendJsonl } from '@vn/util';
import type { ProjectPaths } from '@vn/store';

/** Appends a task's current state as one JSONL record. */
export async function logTask(paths: ProjectPaths, task: AnyTask): Promise<void> {
  await appendJsonl(paths.tasksLog, task);
}
