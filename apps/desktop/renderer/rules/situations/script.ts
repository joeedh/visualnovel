/** The script page's situations: what is on the page, which line is open, and what act is pending. */
import { situations } from './situation.js';
import type { ScriptPageState } from '../script.js';

const shown = {
  sceneId: 'arrival',
  heading: 'EXT. SCHOOL GATE - MORNING',
  lines: [
    { id: 'arrival:L1', text: 'Aiko stops at the gate.' },
    { id: 'arrival:L2', text: 'AIKO: Is this the place?' },
  ],
};

const base: ScriptPageState = { shown, editingLine: null, pending: null, sceneId: 'arrival' };

export const SITUATIONS = situations<ScriptPageState>(
  {
    name : 'no-scene',
    why  : 'No scene is loaded, so nothing is drawn.',
    state: { ...base, shown: undefined, sceneId: '' },
  },
  {
    name : 'scene',
    why: 'A scene is on the page: its heading opens the move dialog and each line opens a text box.',
    state: base,
  },
  {
    name : 'editing-a-line',
    why  : 'One line’s box is open, so that line’s control is left out.',
    state: { ...base, editingLine: 'arrival:L1' },
  },
  {
    name : 'pending-merge',
    why  : 'A merge is pending, so the strip’s button offers story.mergeScene.',
    state: { ...base, pending: { act: 'merge', absorbed: 'departure' } },
  },
  {
    name : 'pending-split',
    why  : 'A split is pending, so the strip’s button offers story.splitScene.',
    state: { ...base, pending: { act: 'split', at: 'arrival:L2', into: 'arrival_2' } },
  },
  {
    name : 'pending-scene',
    why  : 'A new scene is pending, so the strip’s button offers story.newScene.',
    state: { ...base, pending: { act: 'scene', scene: 'scene_2', heading: 'INT. HALL - DAY' } },
  },
);
