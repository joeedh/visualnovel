import { taskActivity } from '../taskactivity.js';
import type { Task } from '../ipc.js';

const task = (hash: string, status: Task['status']): Task => ({
  hash,
  status,
  kind    : 'shot_image',
  deps    : [],
  attempts: [],
  inputs  : { shotId: 'same-slot', prompt: hash, refs: [], params: { modelId: 'test' } },
});

it('only reports the owned version as running and preserves superseded history', () => {
  const tasks = [task('old', 'running'), task('current', 'running'), task('done', 'done')];
  expect(
    taskActivity(tasks, { current: 'drawing' }).map((t) => [t.hash, t.status, !!t.interrupted]),
  ).toEqual([
    ['old', 'pending', true],
    ['current', 'running', false],
    ['done', 'done', false],
  ]);
  expect(tasks[0]!.status).toBe('running');
  expect(taskActivity(tasks, {}).filter((t) => t.status === 'running')).toEqual([]);
});
