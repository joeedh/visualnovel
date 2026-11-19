/**
 * What the task log says about a sheet row. The take the log says a slot holds is the solver's
 * `loggedTake`.
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
