/**
 * The line menu's situations: a line whose covering shot is drawn, one whose shot has no frame,
 * and one no shot covers.
 */
import { situations } from './situation.js';
import type { CoverageShot, SceneCoverage } from '../../../src/shared/ipc.js';

export interface LineMenuState {
  scene: SceneCoverage;
  lineId: string;
}

const shot = (id: string, covers: string[], image?: CoverageShot['image']): CoverageShot => ({
  id,
  framing    : 'wide',
  subjects   : ['aiko'],
  location   : 'gate',
  outfits    : {},
  coversLines: covers,
  aspect     : '16:9',
  status     : 'accepted',
  drift      : 'current',
  ...(image ? { image } : {}),
});

const scene: SceneCoverage = {
  sceneId   : 'arrival',
  location  : 'GATE',
  heading   : 'INT. GATE - DAY',
  lines: [
    { id: 'arrival:L1', kind: 'narration', text: 'The gate stands open.' },
    { id: 'arrival:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
    { id: 'arrival:L3', kind: 'narration', text: 'Nobody answers.' },
  ],
  shots: [
    shot('arrival:s1', ['arrival:L1'], { hash: 'a1b2c3d4', ext: 'png' }),
    shot('arrival:s2', ['arrival:L2']),
  ],
  cast      : [],
  characters: [],
  variants  : ['day'],
  decomposed: true,
  lettering : 'model',
  imageModel: 'mock-image',
};

export const SITUATIONS = situations<LineMenuState>(
  {
    name : 'drawn',
    why  : 'The shot covering the line has a frame, so Open shot asset leaves for it.',
    state: { scene, lineId: 'arrival:L1' },
  },
  {
    name : 'undrawn',
    why  : 'The shot covering the line has no frame yet, so Open shot asset is refused saying so.',
    state: { scene, lineId: 'arrival:L2' },
  },
  {
    name : 'uncovered',
    why  : 'No shot covers the line, which is a different refusal with a different next move.',
    state: { scene, lineId: 'arrival:L3' },
  },
);
