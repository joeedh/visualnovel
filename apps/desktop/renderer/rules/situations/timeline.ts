/** The timeline's situations: whether a scene is on screen, and whether its doors have answered. */
import { situations } from './situation.js';
import { byHandDoor, decomposeDoor, doorKey, type TimelineState } from '../timeline/controls.js';

const undecomposed = { sceneId: 'arrival', firstLine: 'arrival:L1' };

export const SITUATIONS = situations<TimelineState>(
  {
    name : 'no-scene',
    why  : 'No scene is on screen, so + shot is refused.',
    state: { sceneId: '', verdicts: {} },
  },
  {
    name : 'decomposed',
    why  : 'The scene has shots, so + shot is offered and no door is drawn.',
    state: { sceneId: 'arrival', verdicts: {} },
  },
  {
    name : 'undecomposed-unasked',
    why  : 'The scene has no shots and the doors have not answered, so only + shot is anchored.',
    state: { sceneId: 'arrival', undecomposed, verdicts: {} },
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
);
