import { controls, createAction, renameAction, rowAction, type RowState } from '../documents.js';
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

describe('controls', () => {
  it('lists one offer per row, after the bar', () => {
    const rows = { list: [scene, asset], selection: NONE, visible: ['documents' as const] };
    expect(controls({ rows }).map(keyOf)).toEqual([
      'cmd:doc.create',
      'item:scene/arrival',
      'item:asset/a1b2c3d4',
    ]);
  });

  it('lists the create button, and the rename box only while one is open', () => {
    expect(controls({}).map(keyOf)).toEqual(['cmd:doc.create']);
    const renaming = { path: 'wiki/lore.md', name: 'Lore' };
    const listed = controls({ renaming });
    expect(new Set(listed.map(keyOf))).toEqual(
      new Set([createAction(), renameAction(renaming)].map(keyOf)),
    );
    expect(duplicateKeys(listed)).toEqual([]);
  });
});
