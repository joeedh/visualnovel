/**
 * The shot menu's three situations. One shot has a drawn frame, one has no frame yet, and one is
 * a page: several panels, drawn portrait, whose menu is the frame's menu because a page is one
 * asset.
 */
import { situations } from './situation.js';
import type { CoverageShot } from '../../../src/shared/ipc.js';

export interface ShotMenuState {
  sceneId: string;
  shot: CoverageShot;
}

const bare: CoverageShot = {
  id         : 'arrival:s1',
  framing    : 'wide',
  subjects   : ['aiko'],
  location   : 'gate',
  outfits    : {},
  coversLines: ['arrival:L1'],
  aspect     : '16:9',
  drift      : 'current',
};

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

export const SITUATIONS = situations<ShotMenuState>(
  {
    name : 'drawn',
    why  : 'The shot has a frame, so Open shot asset leaves for it in the Asset editor.',
    state: { sceneId: 'arrival', shot: { ...bare, image: { hash: 'a1b2c3d4', ext: 'png' } } },
  },
  {
    name : 'undrawn',
    why  : 'The shot has no frame yet, so Open shot asset is refused with the strip’s sentence.',
    state: { sceneId: 'arrival', shot: bare },
  },
  {
    name : 'page',
    why  : 'A drawn page of two panels gets the same menu as a frame: one asset, one image.',
    state: {
      sceneId: 'arrival',
      shot: {
        ...bare,
        coversLines: ['arrival:L1', 'arrival:L2'],
        panels: [
          { shape: TOP, framing: 'wide', subjects: [], coversLines: ['arrival:L1'] },
          { shape: BOTTOM, framing: 'close', subjects: [], coversLines: ['arrival:L2'] },
        ],
        aspect     : '3:4',
        image      : { hash: 'a1b2c3d4', ext: 'png' },
      },
    },
  },
);
