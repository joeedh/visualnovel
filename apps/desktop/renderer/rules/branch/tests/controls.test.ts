import {
  reloadAction,
  namingBox,
  labelOpenAction,
  fitAction,
  cancelAction,
  labelAction,
  cardAction,
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

describe('cardAction', () => {
  it('selects the scene, keeps a shot of its own and drops one from elsewhere', () => {
    const card = { id: 'intro', reachable: true };
    expect(cardAction(card, 'intro__s1')).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { sceneId: 'intro' },
      on     : 'scene/intro',
      label  : 'intro',
      tooltip:
        'intro — click to select it, right-click to open its script, drag it to lay the graph out',
      then   : [{ id: 'drag.start', props: { interaction: 'branch.splice' } }],
    });
    expect(cardAction(card, 'outro__s1')).toMatchObject({
      props: { sceneId: 'intro', shotId: '' },
    });
    expect(keyOf(cardAction(card, ''))).toBe('item:scene/intro');
  });

  it('says when nothing reaches the scene', () => {
    expect(cardAction({ id: 'lost', reachable: false }, '').tooltip).toMatch(/nothing reaches/);
  });

  it('is listed after the bar, and beside the naming row', () => {
    const cards = { scenes: [{ id: 'intro', reachable: true }], shotId: '' };
    expect(controls(state({ cards })).map(keyOf)).toEqual([
      'cmd:story.newScene',
      'fx:pane.view#fit',
      'fx:pane.view#reload',
      'item:scene/intro',
    ]);
    const naming = { scene: 'scene_2', heading: 'INT. HALL - DAY' };
    expect(controls(state({ cards, naming })).slice(2)).toEqual([
      writeSceneAction(naming),
      cancelAction(),
      fitAction(),
      reloadAction(),
      cardAction({ id: 'intro', reachable: true }, ''),
    ]);
  });
});

describe('controls', () => {
  const naming = { scene: 'scene_2', heading: 'INT. HALL - DAY' };

  const BAR = ['fx:pane.view#fit', 'fx:pane.view#reload'];

  it('is the add button and the view buttons until the delete verdict is in', () => {
    expect(controls(state()).map(keyOf)).toEqual(['cmd:story.newScene', ...BAR]);
    expect(fitAction()).toMatchObject({ props: { what: 'fit' }, label: 'Fit' });
    expect(reloadAction()).toMatchObject({ props: { what: 'reload' }, label: 'Refresh' });
  });

  it('adds the delete button once its verdict is in for the scene on screen', () => {
    const answered = state({ deleteVerdict: { scene: 'intro', check: ACCEPT } });
    expect(controls(answered).map(keyOf)).toEqual([
      'cmd:story.newScene',
      'cmd:story.deleteScene',
      ...BAR,
    ]);
  });

  it('leaves the delete button out for an unknown scene, and for a verdict about another', () => {
    const verdict = { scene: 'intro', check: ACCEPT };
    const bare = ['cmd:story.newScene', ...BAR];
    expect(controls(state({ known: false, deleteVerdict: verdict })).map(keyOf)).toEqual(bare);
    expect(controls(state({ sceneId: 'outro', deleteVerdict: verdict })).map(keyOf)).toEqual(bare);
    expect(controls(state({ sceneId: '', known: false })).map(keyOf)).toEqual(bare);
  });

  // The bar hides its two buttons while the row is open, and the row takes their place
  it('is the naming row’s fields, Write it and Cancel while a scene is being named', () => {
    const open = state({ naming, deleteVerdict: { scene: 'intro', check: ACCEPT } });
    expect(controls(open)).toEqual([
      namingBox(naming, 'scene'),
      namingBox(naming, 'heading'),
      writeSceneAction(naming),
      cancelAction(),
      fitAction(),
      reloadAction(),
    ]);
    expect(namingBox(naming, 'heading')).toMatchObject({
      id     : 'story.newScene',
      on     : 'heading',
      label  : "The new scene's heading",
      tooltip: "The new scene's heading. Enter writes the scene, Escape gives up.",
    });
    expect(cancelAction()).toMatchObject({ props: { popup: 'box' }, on: 'cancel' });
  });

  it('offers each labelled edge’s box opener, except the one whose box is open', () => {
    const edge = { id: 'e1', from: 'a', to: 'b', kind: 'choice' as const, index: 0, label: 'Go' };
    const next = { ...edge, id: 'e2', kind: 'next' as const, label: undefined };
    expect(controls(state({ edges: [edge, next] })).map(keyOf)).toEqual([
      'cmd:story.newScene',
      ...BAR,
      'fx:popup.open#label/e1',
    ]);
    expect(
      controls(state({ edges: [edge], labelling: edge }))
        .map(keyOf)
        .slice(-1),
    ).toEqual(['cmd:story.setChoice#edge/e1']);
    expect(labelOpenAction(edge)).toMatchObject({ label: 'Go', tooltip: 'Rename this choice' });
  });

  it('lists every control the editor draws, each key once', () => {
    for (const s of [
      state(),
      state({ deleteVerdict: { scene: 'intro', check: REFUSE } }),
      state({ naming }),
    ]) {
      const listed = controls(s);
      const each = s.naming
        ? [
            namingBox(s.naming, 'scene'),
            namingBox(s.naming, 'heading'),
            writeSceneAction(s.naming),
            cancelAction(),
          ]
        : [newSceneAction()];
      if (!s.naming && s.deleteVerdict)
        each.push(deleteSceneAction(s.sceneId, s.deleteVerdict.check));
      each.push(fitAction(), reloadAction());
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});

describe('labelAction', () => {
  it('names the choice and leaves the text to the box', () => {
    expect(
      labelAction({ id: 'e1', from: 'a', to: 'b', kind: 'choice', index: 1, label: 'Go' }),
    ).toEqual({
      ok      : true,
      id      : 'story.setChoice',
      on      : 'edge/e1',
      label   : 'Go',
      tooltip : 'What this choice reads as in the game. Enter renames it, Escape leaves it.',
      props   : { scene: 'a', goto: 'b', index: 1 },
      supplies: ['label'],
    });
  });

  it('refuses a next edge, which carries no label', () => {
    expect(labelAction({ id: 'e2', from: 'a', to: 'b', kind: 'next' })).toMatchObject({
      ok     : false,
      refusal: { reason: 'Only a choice carries a label.' },
      label  : '',
    });
  });

  it('is listed first while the box is open, beside the bar or the naming row', () => {
    const labelling = { id: 'e1', from: 'a', to: 'b', kind: 'choice' as const, index: 0 };
    const base = { sceneId: '', known: false, naming: null };
    expect(controls({ ...base, labelling }).map(keyOf)).toEqual([
      'cmd:story.newScene',
      'fx:pane.view#fit',
      'fx:pane.view#reload',
      'cmd:story.setChoice#edge/e1',
    ]);
    expect(
      controls({ ...base, labelling, naming: { scene: 's', heading: 'INT. X - DAY' } })
        .map(keyOf)
        .slice(-1),
    ).toEqual(['cmd:story.setChoice#edge/e1']);
  });
});
