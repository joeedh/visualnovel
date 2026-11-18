/**
 * What the task log says about a slot's take. Nothing here writes; `@vn/artgen`'s `migrateCurrent`
 * and `repairCurrent` bring the manifest's `current` bits into line with it.
 */
import type { AnyTask } from '@vn/types';

/** The angle a sheet task was for, off the task log. */
export function angleOfTask(graph: {
  get(hash: string): AnyTask | undefined;
}): (sourceTask: string | undefined) => string | undefined {
  return (sourceTask) => {
    const task = sourceTask === undefined ? undefined : graph.get(sourceTask);
    return task && 'angle' in task.inputs ? task.inputs.angle : undefined;
  };
}

/** The take the log says a slot holds, or `undefined` where the row is authoritative. */
export function loggedTake(task: AnyTask | undefined): string | undefined {
  if (!task) return undefined;
  if (task.status === 'done') return task.output;
  if (task.status === 'needs_human') return task.output ?? task.attempts.at(-1)?.output;
  return undefined;
}
