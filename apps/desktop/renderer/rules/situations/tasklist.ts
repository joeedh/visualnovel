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

const NOTHING_SELECTED = {
  sceneId    : '',
  shotId     : '',
  characterId: '',
  docPath    : '',
  assetHash  : '',
  graphSlug  : '',
};

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
      cards      : { tasks: TASKS, selection: NOTHING_SELECTED },
    },
  },
  {
    name : 'fold-open-log',
    why: "The shot's log is open on its Log half, with reviewer calls to switch to. The other task's fold is closed.",
    state: {
      gatePending: [],
      cards: {
        tasks    : TASKS,
        selection: NOTHING_SELECTED,
        folds    : { f1e2d3c4: { mode: 'log', lines: 3, reviews: 4 } },
      },
    },
  },
  {
    name : 'fold-open-no-reviews',
    why: 'A task no reviewer saw has its log open, so the Reviewer half is refused with the reason.',
    state: {
      gatePending: [],
      cards: {
        tasks    : TASKS,
        selection: NOTHING_SELECTED,
        folds    : { e5f6a7b8: { mode: 'log', lines: 1, reviews: 0 } },
      },
    },
  },
  {
    name : 'fold-open-reviewer',
    why  : "The shot's fold is switched to its reviewer transcripts.",
    state: {
      gatePending: [],
      cards: {
        tasks    : TASKS,
        selection: NOTHING_SELECTED,
        folds    : { f1e2d3c4: { mode: 'review', lines: 3, reviews: 4 } },
      },
    },
  },
);
