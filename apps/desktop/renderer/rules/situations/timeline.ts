/**
 * The timeline's situations: whether a scene is on screen, whether its doors have answered, and
 * whether a shot is selected under the wardrobe strip.
 */
import { situations } from './situation.js';
import { byHandDoor, decomposeDoor, doorKey, type TimelineState } from '../timeline/controls.js';
import type { ShotCast } from '../timeline/cast.js';
import type { OutfitRow } from '../timeline/wardrobe.js';

const undecomposed = { sceneId: 'arrival', firstLine: 'arrival:L1' };

const lines = [
  { id: 'arrival:L1', text: 'Aiko stops at the gate.' },
  { id: 'arrival:L2', text: 'AIKO: Is this the place?' },
];

const shots = [{ id: 'arrival__s1' }];

const sheet = { id: 'uniform', origin: 'default' } as const;

const sceneRow = (character: string): OutfitRow => ({
  level: 'scene',
  scene: 'arrival',
  character,
  outfits  : ['uniform', 'casual'],
  value    : '',
  effective: sheet,
  inherits : sheet,
});

const shotRow = (character: string): OutfitRow => ({
  level: 'shot',
  scene: 'arrival',
  shot : 'arrival__s1',
  character,
  outfits  : ['uniform', 'casual'],
  value    : 'casual',
  effective: { id: 'casual', origin: 'shot' },
  inherits : sheet,
});

const cast = (framed: string[], spare: string[]): ShotCast => ({
  scene: 'arrival',
  shot : 'arrival__s1',
  framed,
  spare,
  required: true,
  variant : 'day',
  variants: ['day', 'night'],
});

export const SITUATIONS = situations<TimelineState>(
  {
    name : 'no-scene',
    why  : 'No scene is on screen, so + shot is refused and only the bar is drawn.',
    state: { sceneId: '', verdicts: {} },
  },
  {
    name : 'decomposed',
    why: 'The scene has shots, so + shot is offered and no door is drawn; each line has a gutter and opens a box, and the shot’s bracket selects it with a handle at each edge.',
    state: { sceneId: 'arrival', verdicts: {}, lines, shots },
  },
  {
    name : 'editing-a-line',
    why  : 'One line’s box is open, so its box stands in for that line’s control.',
    state: { sceneId: 'arrival', verdicts: {}, lines, shots, editing: 'arrival:L1' },
  },
  {
    name : 'undecomposed-unasked',
    why: 'The scene has no shots and the doors have not answered, so the bar and the lines are anchored and no door is.',
    state: { sceneId: 'arrival', undecomposed, verdicts: {}, lines },
  },
  {
    name : 'undecomposed-asked',
    why: 'Both doors have answered: decompose is priced and offered, placing by hand is refused with the stack’s sentence.',
    state: {
      sceneId: 'arrival',
      undecomposed,
      verdicts: {
        [doorKey('arrival', decomposeDoor())]: {
          state  : 'accept',
          message: 'One model call, for one scene.',
        },
        [doorKey('arrival', byHandDoor('arrival', 'arrival:L1'))]: {
          state  : 'refuse',
          message: 'Line arrival:L1 is already covered by a shot.',
        },
      },
    },
  },
  {
    name : 'shot-selected',
    why: 'A shot framing one of two characters is selected, so the strip offers the scene rows, the variant, the shot row with its remove button, the add select and the checkbox.',
    state: {
      sceneId : 'arrival',
      verdicts: {},
      wardrobe: [sceneRow('aiko'), sceneRow('ren'), shotRow('aiko')],
      cast    : cast(['aiko'], ['ren']),
    },
  },
  {
    name : 'shot-frames-nobody',
    why: 'The selected shot frames nobody, so there is no shot row or remove button, and the checkbox is refused.',
    state: {
      sceneId : 'arrival',
      verdicts: {},
      wardrobe: [sceneRow('aiko'), sceneRow('ren')],
      cast    : cast([], ['aiko', 'ren']),
    },
  },
);
