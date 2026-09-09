/** The Task List pane's situations: whether a run is waiting at a gate, and which cards are drawn. */
import { situations } from './situation.js';
import type { TaskListState } from '../tasklist.js';
import type { ImageParams } from '@vn/types';
import type { Task } from '../../../src/shared/ipc.js';

const PARAMS: ImageParams = { modelId: 'mock-image' };

/** A shot that rendered a frame, and a prompt refinement that drew nothing. */
const TASKS: readonly Task[] = [
  {
    hash    : 'f1e2d3c4',
    kind    : 'shot_image',
    deps    : [],
    status  : 'needs_human',
    attempts: [],
    output  : 'a1b2c3d4',
    inputs  : { shotId: 'arrival__s1', prompt: '', refs: [], params: PARAMS },
  },
  {
    hash    : 'e5f6a7b8',
    kind    : 'prompt_refine',
    deps    : [],
    status  : 'done',
    attempts: [],
    inputs  : { basePrompt: 'Café Mori at night', defects: 'too bright', modelId: 'mock-llm' },
  },
];

export const SITUATIONS = situations<TaskListState>(
  {
    name : 'idle',
    why: 'Only the bar is drawn: Run, the three status ticks, Clear finished refused with nothing to clear, and Refresh.',
    state: { gatePending: [] },
  },
  {
    name : 'gate-pending',
    why  : 'A run is waiting on a portrait, so the gate bar offers approval for that character.',
    state: { gatePending: ['aiko'] },
  },
  {
    name : 'cards',
    why: 'Two cards are drawn: a shot that rendered a frame opens it elsewhere after the pick, a task that drew nothing only publishes. One is done, so Clear finished is offered.',
    state: {
      gatePending: [],
      clearable  : true,
      cards: {
        tasks    : TASKS,
        selection: {
          sceneId    : '',
          shotId     : '',
          characterId: '',
          docPath    : '',
          assetHash  : '',
          graphSlug  : '',
        },
      },
    },
  },
);
