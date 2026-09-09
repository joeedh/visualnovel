/** The script page's situations: what is on the page, which line is open, and what act is pending. */
import { situations } from './situation.js';
import type { ScriptPageState } from '../script.js';

const shown = {
  sceneId: 'arrival',
  heading: 'EXT. SCHOOL GATE - MORNING',
  lines: [
    { id: 'arrival:L1', text: 'Aiko stops at the gate.', kind: 'transition' as const },
    {
      id     : 'arrival:L2',
      text   : 'AIKO: Is this the place?',
      kind   : 'dialogue' as const,
      speaker: 'AIKO',
    },
  ],
};

const cast = [{ id: 'aiko', name: 'Aiko' }];

const base: ScriptPageState = {
  shown,
  editingLine: null,
  pending    : null,
  sceneId    : 'arrival',
  cast,
  absorb   : 'departure',
  continues: true,
};

export const SITUATIONS = situations<ScriptPageState>(
  {
    name : 'no-scene',
    why  : 'No scene is loaded, so only the bar is drawn: the scene picker and reload.',
    state: { ...base, shown: undefined, sceneId: '', absorb: undefined, continues: undefined },
  },
  {
    name : 'scene',
    why: 'A scene is on the page: its heading opens the move dialog, each line has a drag handle and opens a text box, the spoken line has a cue slot, the second line offers a split, and the structure buttons add a line, merge the next scene in, or continue to a new one.',
    state: base,
  },
  {
    name : 'empty-scene',
    why  : 'A scene with no lines invites the first one and offers nothing to split or add to.',
    state: { ...base, shown: { ...shown, lines: [] } },
  },
  {
    name : 'editing-a-line',
    why  : 'One line’s box is open, so its box stands in for that line’s control.',
    state: { ...base, editingLine: 'arrival:L1' },
  },
  {
    name : 'composing',
    why  : 'A composer is open under the last line, so its box offers the insert it would commit.',
    state: { ...base, composing: 'arrival:L2' },
  },
  {
    name : 'with-frames',
    why: 'Two frames were drawn from this scene, so the strip under the page opens each in the asset editor.',
    state: {
      ...base,
      frames: {
        assets: [
          { hash: 'a1b2c3d4', label: 'arrival__s1', accepted: true },
          { hash: 'b2c3d4e5', label: 'arrival__s2', accepted: false },
        ],
        visible: ['script', 'documents'],
      },
    },
  },
  {
    name : 'picking-a-speaker',
    why  : 'One line’s cue picker is open, so that slot says what picking does.',
    state: { ...base, attributing: 'arrival:L2' },
  },
  {
    name : 'pending-merge',
    why: 'A merge is pending, so the strip’s button offers story.mergeScene, Cancel closes it, and no split is offered.',
    state: { ...base, pending: { act: 'merge', absorbed: 'departure' } },
  },
  {
    name : 'pending-split',
    why  : 'A split is pending, so the strip’s id field and button offer story.splitScene.',
    state: { ...base, pending: { act: 'split', at: 'arrival:L2', into: 'arrival_2' } },
  },
  {
    name : 'pending-scene',
    why: 'A new scene is pending, so the strip’s id and heading fields and its button offer story.newScene.',
    state: { ...base, pending: { act: 'scene', scene: 'scene_2', heading: 'INT. HALL - DAY' } },
  },
);
