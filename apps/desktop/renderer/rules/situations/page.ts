/**
 * The Page editor's situations: no shot, a frame, a page with nothing selected, a page with a
 * panel selected — which is when the corners and the side column's fields are drawn — a page the
 * reviewers kept blocking, which is when Accept joins Generate in the head, and a page the runner
 * letters, with one bubble placed and held, which is when the anchors and the tail are drawn.
 */
import { situations } from './situation.js';
import type { PageState } from '../page.js';
import type { CoverageShot } from '../../../src/shared/ipc.js';

const lines = [
  { id: 'arrival:L1', kind: 'narration' as const, text: 'Aiko stops at the gate.' },
  { id: 'arrival:L2', kind: 'dialogue' as const, speaker: 'aiko', text: 'Is this the place?' },
  { id: 'arrival:L3', kind: 'dialogue' as const, speaker: 'ren', text: 'It was.' },
];

const TOP: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 0.5],
  [0, 0.5],
];
const BOTTOM: [number, number][] = [
  [0, 0.5],
  [1, 0.5],
  [1, 1],
  [0, 1],
];

const drawn: CoverageShot = {
  id         : 'arrival__s1',
  framing    : 'wide',
  subjects   : ['aiko', 'ren'],
  location   : 'gate',
  outfits    : {},
  coversLines: ['arrival:L1', 'arrival:L2', 'arrival:L3'],
  aspect     : '16:9',
  status     : 'accepted',
  drift      : 'current',
};

const frame: CoverageShot = {
  ...drawn,
  undrawable:
    'The "day" plate for gate has not been rendered, and a frame’s identity is built on it — ' +
    'run the pipeline far enough to produce it.',
};

const page: CoverageShot = {
  ...drawn,
  id    : 'arrival__page1',
  aspect: '3:4',
  panels: [
    { shape: TOP, framing: 'wide', subjects: [], coversLines: ['arrival:L1'] },
    {
      shape      : BOTTOM,
      framing    : 'close',
      subjects   : [{ characterId: 'aiko' }],
      coversLines: ['arrival:L2'],
    },
  ],
  image : { hash: 'a1b2c3d4', ext: 'png' },
};

const flagged: CoverageShot = {
  ...page,
  status : 'pending',
  failure: {
    task   : 't1',
    status : 'needs_human',
    defects: ['Panel 2 shows ren, who is not in it.'],
  },
};

const lettered: CoverageShot = {
  ...page,
  panels: [
    page.panels![0]!,
    {
      ...page.panels![1]!,
      bubbles: [{ lineId: 'arrival:L2', anchor: [0.5, 0.7], tail: [0.4, 0.85] }],
    },
  ],
};

const characters = ['aiko', 'ren', 'sato'];
const imageModel = 'mock-image';

export const SITUATIONS = situations<PageState>(
  {
    name : 'no-shot',
    why  : 'Nothing is selected, so the pane is a sentence and no control is drawn.',
    state: { sceneId: 'arrival', shots: [frame, page], shotId: '', lines, selected: null },
  },
  {
    name : 'frame',
    why: 'The shot is a single frame whose plate is not drawn yet: the layout row offers to make it a page, its lines refuse to be dragged, Generate is refused with the resolver’s sentence, and there is no panel to select.',
    state: {
      sceneId: 'arrival',
      shots  : [frame, page],
      shotId : 'arrival__s1',
      lines,
      selected: null,
      characters,
      imageModel,
    },
  },
  {
    name : 'page',
    why: 'A two-panel page with no panel selected: the layout it sits in is refused as already so, each panel selects, each line drags, the cast row takes one out or puts sato in, and the side column offers nothing yet.',
    state: {
      sceneId: 'arrival',
      shots  : [frame, page],
      shotId : 'arrival__page1',
      lines,
      selected: null,
      characters,
      imageModel,
    },
  },
  {
    name : 'panel-selected',
    why: 'The second panel is selected, so its four corners are drawn, its framing, camera and notes take a value, and the cast toggles show aiko in and ren out.',
    state: {
      sceneId: 'arrival',
      shots  : [frame, page],
      shotId : 'arrival__page1',
      lines,
      selected: 1,
      characters,
      imageModel,
    },
  },
  {
    name : 'flagged',
    why: 'The page was drawn but the reviewers kept blocking it: the head names the defects, Regenerate draws it again, and Accept keeps it as it stands.',
    state: {
      sceneId: 'arrival',
      shots  : [frame, flagged],
      shotId : 'arrival__page1',
      lines,
      selected: null,
      characters,
      imageModel,
    },
  },
  {
    name : 'runner-lettered',
    why: 'The runner letters this project’s pages: each lettered line has an anchor on the page — line 1 a ghost at its panel’s centre, line 2 placed — and line 2’s bubble is held, so its tail handle is drawn too. Line 3 is in no panel and has no anchor.',
    state: {
      sceneId: 'arrival',
      shots  : [frame, lettered],
      shotId : 'arrival__page1',
      lines,
      selected: null,
      characters,
      imageModel,
      lettering: 'runner',
      bubble   : 'arrival:L2',
    },
  },
);
