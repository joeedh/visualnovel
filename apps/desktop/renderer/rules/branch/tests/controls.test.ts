import {
  controls,
  deleteSceneAction,
  newSceneAction,
  removes,
  writeSceneAction,
  type BranchState,
} from '../controls.js';
import { duplicateKeys, keyOf } from '../../anchors.js';
import type { CommandCheck } from '../../../../src/shared/ipc';

const ACCEPT: CommandCheck = { state: 'accept', message: 'Removes intro and 3 shots.' };
const REFUSE: CommandCheck = { state: 'refuse', message: 'Two scenes still branch to intro.' };
const UNDECLARED: CommandCheck = { state: 'undeclared', message: '' };

const state = (over: Partial<BranchState> = {}): BranchState => ({
  sceneId: 'intro',
  known  : true,
  naming : null,
  ...over,
});

describe('newSceneAction', () => {
  it('opens the naming row, with the id and heading typed after the click', () => {
    expect(newSceneAction()).toEqual({
      ok      : true,
      id      : 'story.newScene',
      props   : {},
      label   : '+ scene',
      tooltip : 'Name a new scene and add it to the graph, unconnected',
      supplies: ['scene', 'heading'],
    });
  });
});

describe('deleteSceneAction', () => {
  it('removes the scene, with the accepted check’s count as its tooltip', () => {
    expect(deleteSceneAction('intro', ACCEPT)).toEqual({
      ok     : true,
      id     : 'story.deleteScene',
      props  : { scene: 'intro' },
      label  : 'delete intro',
      tooltip: ACCEPT.message,
    });
  });

  // An undeclared check has no sentence, so the button keeps the one it was drawn with
  it('falls back to its own sentence when the check says nothing', () => {
    expect(deleteSceneAction('intro', UNDECLARED)).toMatchObject({
      ok     : true,
      tooltip: removes('intro'),
    });
  });

  it('greys the button with the command’s refusal, keeping its own sentence beneath', () => {
    expect(deleteSceneAction('intro', REFUSE)).toMatchObject({
      ok     : false,
      id     : 'story.deleteScene',
      label  : 'delete intro',
      tooltip: removes('intro'),
      refusal: { reason: REFUSE.message },
    });
  });
});

describe('writeSceneAction', () => {
  it('writes the draft as it stands', () => {
    expect(writeSceneAction({ scene: 'scene_2', heading: 'INT. HALL - DAY' })).toEqual({
      ok     : true,
      id     : 'story.newScene',
      props  : { scene: 'scene_2', heading: 'INT. HALL - DAY' },
      label  : 'Write it',
      tooltip: 'Create the scene file and put it on the graph, connected to nothing',
    });
  });
});

describe('controls', () => {
  const naming = { scene: 'scene_2', heading: 'INT. HALL - DAY' };

  it('is the add button alone until the delete verdict is in', () => {
    expect(controls(state()).map(keyOf)).toEqual(['cmd:story.newScene']);
  });

  it('adds the delete button once its verdict is in for the scene on screen', () => {
    const answered = state({ deleteVerdict: { scene: 'intro', check: ACCEPT } });
    expect(controls(answered).map(keyOf)).toEqual(['cmd:story.newScene', 'cmd:story.deleteScene']);
  });

  it('leaves the delete button out for an unknown scene, and for a verdict about another', () => {
    const verdict = { scene: 'intro', check: ACCEPT };
    expect(controls(state({ known: false, deleteVerdict: verdict })).map(keyOf)).toEqual([
      'cmd:story.newScene',
    ]);
    expect(controls(state({ sceneId: 'outro', deleteVerdict: verdict })).map(keyOf)).toEqual([
      'cmd:story.newScene',
    ]);
    expect(controls(state({ sceneId: '', known: false })).map(keyOf)).toEqual([
      'cmd:story.newScene',
    ]);
  });

  // The bar hides its two buttons while the row is open, and the row's Write it takes their place
  it('is the naming row’s Write it alone while a scene is being named', () => {
    const open = state({ naming, deleteVerdict: { scene: 'intro', check: ACCEPT } });
    expect(controls(open)).toEqual([writeSceneAction(naming)]);
  });

  it('lists every control the editor draws, each key once', () => {
    for (const s of [
      state(),
      state({ deleteVerdict: { scene: 'intro', check: REFUSE } }),
      state({ naming }),
    ]) {
      const listed = controls(s);
      const each = s.naming ? [writeSceneAction(s.naming)] : [newSceneAction()];
      if (!s.naming && s.deleteVerdict)
        each.push(deleteSceneAction(s.sceneId, s.deleteVerdict.check));
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});
