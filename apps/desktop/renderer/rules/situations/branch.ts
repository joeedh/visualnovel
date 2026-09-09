/** The branch editor's situations: which scene is selected, and what its delete check said. */
import { situations } from './situation.js';
import type { BranchState } from '../branch/controls.js';

const base: BranchState = { sceneId: 'arrival', known: true, naming: null };

const edge = {
  id   : 'e1',
  from : 'arrival',
  to   : 'cafe',
  kind : 'choice' as const,
  index: 0,
  label: 'Go in',
};

export const SITUATIONS = situations<BranchState>(
  {
    name : 'no-scene',
    why  : 'Nothing is selected, so the bar offers + scene, Fit and Refresh and nothing else.',
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
    why: 'The naming row is open, so its two fields, Write it and Cancel stand in for + scene and delete.',
    state: { ...base, naming: { scene: 'scene_2', heading: 'INT. HALL - DAY' } },
  },
  {
    name : 'labelling',
    why: 'A choice’s label box is open, so the box offers story.setChoice with the text typed after, and stands in for the label that opened it.',
    state: { ...base, labelling: edge, edges: [edge] },
  },
  {
    name : 'cards',
    why: 'Two cards are drawn while a shot of the first is selected, so pressing the second clears the shot and pressing the first keeps it; nothing reaches the second. The choice between them has a label that opens its box.',
    state: {
      ...base,
      sceneId: '',
      known  : false,
      edges  : [edge],
      cards: {
        scenes: [
          { id: 'arrival', reachable: true },
          { id: 'cafe', reachable: false },
        ],
        shotId: 'arrival__s1',
      },
    },
  },
);
