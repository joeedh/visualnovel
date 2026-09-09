/** The Inspector's situations: whether a task is on screen. */
import { situations } from './situation.js';
import type { InspectorState } from '../inspector.js';

export const SITUATIONS = situations<InspectorState>(
  {
    name : 'no-task',
    why  : 'Nothing is selected, so only Refresh is drawn.',
    state: { shown: false },
  },
  {
    name : 'task',
    why  : 'A task is on screen; its attempts are read-only, so Refresh is still the one control.',
    state: { shown: true },
  },
);
