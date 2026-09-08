/** The Task List pane's situations: whether a run is waiting at a gate. */
import { situations } from './situation.js';
import type { TaskListState } from '../tasklist.js';

export const SITUATIONS = situations<TaskListState>(
  { name: 'idle', why: 'Only the Run button is drawn.', state: { gatePending: [] } },
  {
    name : 'gate-pending',
    why  : 'A run is waiting on a portrait, so the gate bar offers approval for that character.',
    state: { gatePending: ['aiko'] },
  },
);
