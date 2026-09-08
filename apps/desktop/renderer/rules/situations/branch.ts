/** The branch editor's situations: which scene is selected, and what its delete check said. */
import { situations } from './situation.js';
import type { BranchState } from '../branch/controls.js';

const base: BranchState = { sceneId: 'arrival', known: true, naming: null };

export const SITUATIONS = situations<BranchState>(
  {
    name : 'no-scene',
    why  : 'Nothing is selected, so only + scene is offered.',
    state: { ...base, sceneId: '', known: false },
  },
  {
    name : 'scene',
    why: 'A deletable scene is selected, so delete is offered with the check’s count as its tooltip.',
    state: {
      ...base,
      deleteVerdict: {
        scene: 'arrival',
        check: { state: 'accept', message: 'Removes arrival and 3 shots.' },
      },
    },
  },
  {
    name : 'entry-scene',
    why  : 'The entry scene cannot be deleted, so delete is refused with the stack’s sentence.',
    state: {
      ...base,
      deleteVerdict: {
        scene: 'arrival',
        check: {
          state  : 'refuse',
          message: 'arrival is the entry scene — point start: in project.yaml elsewhere first.',
        },
      },
    },
  },
  {
    name : 'naming',
    why  : 'The naming row is open, so Write it stands in for the bar’s buttons.',
    state: { ...base, naming: { scene: 'scene_2', heading: 'INT. HALL - DAY' } },
  },
);
