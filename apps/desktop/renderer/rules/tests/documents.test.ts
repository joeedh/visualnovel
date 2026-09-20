import {
  collapseAction,
  controls,
  createAction,
  modeAction,
  panelControls,
  reloadAction,
  renameAction,
  rowAction,
  sceneLinkAction,
  sheetLinkAction,
  shotLinkAction,
  storyInOrder,
  type RowState,
} from '../documents.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { Selection } from '../selection.js';
import type { DocNode } from '../../../src/shared/ipc.js';

const NONE: Selection = {
  sceneId    : '',
  shotId     : '',
  characterId: '',
  docPath    : '',
  assetHash  : '',
  graphSlug  : '',
};

const row = (node: DocNode, expandable = false, expanded = false): RowState => ({
  node,
  expandable,
  expanded,
});

const scene = row(
  { id: 'scene:arrival', kind: 'scene', label: 'arrival', path: 'scenes/arrival.md' },
  true,
);
const asset = row({ id: 'asset:a1b2c3d4', kind: 'asset', label: 'a1b2c3d4' }, true);

describe('createAction', () => {
  it('opens the new-document row, with the kind and the name typed after the click', () => {
    expect(createAction()).toEqual({
      ok      : true,
      id      : 'doc.create',
      props   : {},
      label   : 'New…',
      tooltip : 'Add a character, location, page or skill to this project',
      supplies: ['kind', 'name'],
    });
  });
});

describe('renameAction', () => {
  it('renames the one document, with the box supplying the name', () => {
    expect(renameAction({ path: 'characters/aiko/character.md', name: 'Aiko' })).toEqual({
      ok      : true,
      id      : 'doc.rename',
      props   : { path: 'characters/aiko/character.md' },
      label   : 'Aiko',
      tooltip : 'Type the new name — Enter renames the document, Escape leaves it as it was',
      supplies: ['name'],
    });
  });
});

describe('rowAction', () => {
  it('publishes the scene, then opens Script elsewhere when the tree alone is up', () => {
    expect(rowAction(scene, NONE, ['documents'])).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { sceneId: 'arrival', docPath: 'scenes/arrival.md' },
      on     : 'scene/arrival',
      label  : 'arrival',
      tooltip: 'scenes/arrival.md',
      // Script opens on the selection the click published, so the open carries no subject
      then   : [{ id: 'view.open', props: { editor: 'script', where: 'elsewhere', subject: '' } }],
    });
  });

  it('opens the claimant here when it is already up', () => {
    expect(rowAction(scene, NONE, ['documents', 'script'])).toMatchObject({
      then: [{ id: 'view.open', props: { editor: 'script', where: 'here' } }],
    });
  });

  it('expands a row that names nothing the shell tracks', () => {
    const heading = row({ id: 'branch:story', kind: 'branch', label: 'Story' }, true);
    expect(rowAction(heading, NONE, ['documents'])).toEqual({
      ok     : true,
      id     : 'tree.expand',
      props  : { node: 'branch:story' },
      on     : 'branch/story',
      label  : 'Story',
      tooltip: 'Show or hide what is filed under this heading',
    });
    expect(keyOf(rowAction(heading, NONE, ['documents']))).toBe('fx:tree.expand#branch/story');
  });

  it('expands an asset row already selected, whose children are its earlier takes', () => {
    const selected = { ...NONE, assetHash: 'a1b2c3d4' };
    expect(rowAction(asset, selected, ['documents'])).toMatchObject({ id: 'tree.expand' });
    expect(rowAction(asset, NONE, ['documents'])).toMatchObject({
      id   : 'ui.publish',
      props: { assetHash: 'a1b2c3d4' },
      then : [{ id: 'view.open', props: { editor: 'asset', subject: 'a1b2c3d4' } }],
    });
  });

  it('publishes without opening when the row names the selection already held', () => {
    const inert = row({ id: 'location:cafe', kind: 'location', label: 'Café Mori' });
    expect(rowAction(inert, NONE, ['documents'])).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : {},
      on     : 'location/cafe',
      label  : 'Café Mori',
      tooltip: 'Only a heading names this place — double-click to write its sheet',
    });
  });

  it('keys every row by its kind and key, which is what a select step names', () => {
    expect(keyOf(rowAction(scene, NONE, ['documents']))).toBe('item:scene/arrival');
  });
});

describe('the bar', () => {
  it('labels the mode toggle with the grouping it is in', () => {
    expect(modeAction('documents')).toMatchObject({
      id   : 'pane.view',
      props: { what: 'mode' },
      on   : 'mode',
      label: 'DOCUMENTS',
    });
    expect(modeAction('files')).toMatchObject({ label: 'FILES' });
    expect(modeAction('files').tooltip).not.toBe(modeAction('documents').tooltip);
  });

  it('reloads and folds the tree as view effects', () => {
    expect(reloadAction()).toMatchObject({ id: 'pane.view', props: { what: 'reload' } });
    expect(collapseAction()).toMatchObject({ id: 'tree.expand', props: { node: '*' }, on: 'all' });
  });
});

describe('storyInOrder', () => {
  const scenes = (...ids: string[]): DocNode[] =>
    ids.map((id) => ({ id: `scene:${id}`, kind: 'scene', label: id }));
  const roots: DocNode[] = [
    { id: 'branch:story', kind: 'branch', label: 'Story', children: scenes('b', 'c', 'a') },
    { id: 'branch:characters', kind: 'branch', label: 'Characters', children: [] },
  ];

  it('leaves the tree alone in stored order', () => {
    expect(storyInOrder(roots, 'stored', ['a', 'b', 'c'])).toBe(roots);
  });

  it('sorts only the story branch, by the order the tree carries', () => {
    const sorted = storyInOrder(roots, 'story', ['a', 'b', 'c']);
    expect(sorted[0]!.children!.map((n) => n.id)).toEqual(['scene:a', 'scene:b', 'scene:c']);
    expect(sorted[1]).toBe(roots[1]);
    expect(roots[0]!.children!.map((n) => n.id)).toEqual(['scene:b', 'scene:c', 'scene:a']);
  });

  it('keeps a scene the order does not name at the end, in its stored place', () => {
    const sorted = storyInOrder(roots, 'story', ['a']);
    expect(sorted[0]!.children!.map((n) => n.id)).toEqual(['scene:a', 'scene:b', 'scene:c']);
  });
});

describe('the backlink panel', () => {
  const visible = ['documents' as const];

  it('opens the sheet where the route says, labelled by where it lives', () => {
    const sheet = sheetLinkAction({ path: 'characters/aiko/character.md', wiki: false }, visible);
    expect(sheet).toMatchObject({
      id   : 'ui.publish',
      props: { docPath: 'characters/aiko/character.md' },
      on   : 'link/sheet',
      label: 'sheet · characters/aiko/character.md',
      then : [{ id: 'view.open', props: { editor: 'wiki', where: 'elsewhere' } }],
    });
    expect(sheetLinkAction({ path: 'wiki/aiko.md', wiki: true }, visible).label).toBe(
      'in the story bible · wiki/aiko.md',
    );
  });

  it('selects a scene, or a shot with its scene', () => {
    expect(sceneLinkAction('arrival')).toMatchObject({
      id   : 'ui.publish',
      props: { sceneId: 'arrival', shotId: '' },
      on   : 'link/scene/arrival',
    });
    expect(shotLinkAction('arrival', 'arrival__s1')).toMatchObject({
      props: { sceneId: 'arrival', shotId: 'arrival__s1' },
      on   : 'link/shot/arrival/arrival__s1',
    });
  });

  it('lists the sheet, the art, the scenes and the shots in draw order', () => {
    const panel = {
      sheet : { path: 'characters/aiko/character.md', wiki: false },
      assets: [{ hash: 'a1b2c3d4', label: 'Aiko', accepted: true }],
      scenes: ['arrival'],
      shots : [{ scene: 'arrival', shot: 'arrival__s1' }],
      visible,
    };
    expect(panelControls(panel).map(keyOf)).toEqual([
      'item:link/sheet',
      'item:link/asset/a1b2c3d4',
      'item:link/scene/arrival',
      'item:link/shot/arrival/arrival__s1',
    ]);
    expect(panelControls({ ...panel, sheet: undefined }).map(keyOf)).not.toContain(
      'item:link/sheet',
    );
  });
});

describe('controls', () => {
  const bar = ['fx:pane.view#mode', 'cmd:doc.create', 'fx:pane.view#reload', 'fx:tree.expand#all'];

  it('lists one offer per row, after the bar', () => {
    const rows = { list: [scene, asset], selection: NONE, visible: ['documents' as const] };
    expect(controls({ rows }).map(keyOf)).toEqual([
      ...bar,
      'item:scene/arrival',
      'item:asset/a1b2c3d4',
    ]);
  });

  it('lists the bar, and the rename box only while one is open', () => {
    expect(controls({}).map(keyOf)).toEqual(bar);
    const renaming = { path: 'wiki/lore.md', name: 'Lore' };
    const listed = controls({ renaming });
    expect(new Set(listed.map(keyOf))).toEqual(
      new Set(
        [
          modeAction('documents'),
          createAction(),
          reloadAction(),
          collapseAction(),
          renameAction(renaming),
        ].map(keyOf),
      ),
    );
    expect(duplicateKeys(listed)).toEqual([]);
  });

  it('lists the panel after the rows, with no key shared between them', () => {
    const rows = { list: [scene, asset], selection: NONE, visible: ['documents' as const] };
    const panel = {
      assets : [{ hash: 'a1b2c3d4', label: 'Aiko', accepted: false }],
      scenes : ['arrival'],
      shots  : [],
      visible: ['documents' as const],
    };
    const listed = controls({ rows, panel });
    expect(listed.map(keyOf).slice(-2)).toEqual([
      'item:link/asset/a1b2c3d4',
      'item:link/scene/arrival',
    ]);
    expect(duplicateKeys(listed)).toEqual([]);
  });
});
