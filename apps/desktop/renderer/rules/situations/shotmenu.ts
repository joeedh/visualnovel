/** The shot menu's two situations. One shot has a drawn frame; the other has no frame yet. */
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
  status     : 'accepted',
  drift      : 'current',
};

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
);
