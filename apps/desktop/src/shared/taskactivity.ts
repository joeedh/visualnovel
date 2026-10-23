import type { Task } from './ipc.js';

/** Projects execution ownership over durable records without rewriting history on a read. */
export function taskActivity(
  tasks: readonly Task[],
  activity: Readonly<Record<string, string>>,
): Task[] {
  return tasks.map((task) => {
    if (task.status !== 'running' && task.status !== 'pending') return task;
    if (Object.hasOwn(activity, task.hash))
      return { ...task, status: 'running', interrupted: false };
    return task.status === 'running' ? { ...task, status: 'pending', interrupted: true } : task;
  });
}
