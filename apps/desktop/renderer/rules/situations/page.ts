/**
 * The Page editor's situations: no shot, a frame, a page with nothing selected, and a page with a
 * panel selected — which is when the corners and the side column's fields are drawn.
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

const frame: CoverageShot = {
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

const page: CoverageShot = {
  ...frame,
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

export const SITUATIONS = situations<PageState>(
  {
    name : 'no-shot',
    why  : 'Nothing is selected, so the pane is a sentence and no control is drawn.',
    state: { sceneId: 'arrival', shots: [frame, page], shotId: '', lines, selected: null },
  },
  {
    name : 'frame',
    why: 'The shot is a single frame: the layout row offers to make it a page, its lines refuse to be dragged, and there is no panel to select.',
    state: {
      sceneId: 'arrival',
      shots  : [frame, page],
      shotId : 'arrival__s1',
      lines,
      selected: null,
    },
  },
  {
    name : 'page',
    why: 'A two-panel page with no panel selected: the layout it sits in is refused as already so, each panel selects, each line drags, and the side column offers nothing yet.',
    state: {
      sceneId: 'arrival',
      shots  : [frame, page],
      shotId : 'arrival__page1',
      lines,
      selected: null,
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
    },
  },
);
