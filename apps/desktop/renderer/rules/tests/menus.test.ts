import { MENU_ROWS, menuRecords } from '../menus.js';
import { UX_RECORD } from '../../../src/shared/uxmodel.js';
import { MENU_SEP } from '../../pathux/chrome/contextmenu.js';
import { mapOf, type AnchorRecord } from '../anchors.js';
import type { DocNodeKind } from '../../../src/shared/ipc.js';

const records = menuRecords();

describe('MENU_ROWS', () => {
  it('names each module once, each with at least one situation', () => {
    const modules = MENU_ROWS.map((row) => row.module);
    expect(new Set(modules).size).toBe(modules.length);
    for (const row of MENU_ROWS) expect(row.situations.length).toBeGreaterThan(0);
  });
});

describe('menuRecords', () => {
  it('parses record by record, and carries no separator', () => {
    for (const record of records) expect(() => UX_RECORD.parse(record)).not.toThrow();
    expect(records.some((record) => record.id === MENU_SEP)).toBe(false);
  });

  it('files the tree’s menu under the node, and the others under what was right-clicked', () => {
    const whens = new Set(records.map((record) => record.when));
    expect(whens.has('scene:sample')).toBe(true);
    expect(whens.has('shot:arrival/arrival:s1')).toBe(true);
    expect(whens.has('line:arrival:L1')).toBe(true);
    expect(whens.has('card:arrival')).toBe(true);
    expect(whens.has('card:departure')).toBe(true);
  });

  it('files the header’s menus under header/<menu>, and a submenu’s rows one level down', () => {
    const header = records.filter((record) => record.editor === 'header');
    const whens = new Set(header.map((record) => record.when));
    expect([...whens].sort()).toEqual([
      'header/app',
      'header/app/recent',
      'header/edit',
      'header/help',
      'header/view',
      'header/view/editors',
      'header/view/layout',
    ]);
    // The submenu entry itself is recorded as the effect that opens it
    expect(
      header.find((record) => record.when === 'header/app' && record.id === 'menu.open'),
    ).toMatchObject({ props: { menu: 'recent' }, label: 'Recent Projects' });
    expect(
      header.filter((record) => record.when === 'header/app/recent').map((record) => record.id),
    ).toEqual(expect.arrayContaining(['workspace.open']));
  });

  it('carries the fields a menu row has and a control does not', () => {
    const undo = records.find((r) => r.when === 'header/edit' && r.label === 'Undo')!;
    expect(undo).toMatchObject({ id: 'history.move', shortcut: 'Ctrl+Z' });
    expect(undo.tooltip).toBeDefined();
    const move = records.find((r) => r.label === 'Move Pane to New Window' && r.then)!;
    expect(move.then).toEqual([{ id: 'view.close', props: {} }]);
    const enter = records.find((r) => r.label === 'Edit Group')!;
    expect(enter).toMatchObject({ id: 'pane.view', on: 'enter' });
    const group = records.find((r) => r.label === 'Create Group')!;
    expect(group.supplies).toEqual(['slug', 'nodes']);
    const current = records.find((r) => r.label === 'transfer ✓')!;
    expect(current.refused).toBe('C:/stories/transfer is the project you have open');
  });

  it('draws the shot, line and card menus in their situations', () => {
    const shot = records.filter((r) => r.module === 'shotmenu');
    expect(shot.map((r) => `${r.situation} ${r.id}${r.refused ? ' refused' : ''}`)).toEqual([
      'drawn view.open',
      'drawn story.deleteShot',
      'undrawn view.open refused',
      'undrawn story.deleteShot',
      // A page is one asset, so it gets the drawn frame's menu
      'page view.open',
      'page story.deleteShot',
    ]);
    const line = records.filter((r) => r.module === 'linemenu');
    expect(line.map((r) => r.situation)).toEqual([
      'drawn',
      'drawn',
      'drawn',
      'undrawn',
      'undrawn',
      'undrawn',
      'uncovered',
      'uncovered',
      'uncovered',
    ]);
    expect(line.filter((r) => r.refused).map((r) => r.refused)).toEqual([
      'arrival:s2 covers arrival:L2 but has not been drawn.',
      'No shot covers arrival:L3 yet.',
    ]);
    const card = records.filter((r) => r.module === 'cardmenu');
    expect(card.map((r) => `${r.situation} ${r.id}`)).toEqual([
      'scene view.open',
      'stub story.newScene',
    ]);
  });
});

describe('the tree’s row', () => {
  const tree = records.filter((record) => record.module === 'doctree');

  it('reaches every node kind the tree can draw', () => {
    const kinds: DocNodeKind[] = [
      'branch',
      'scene',
      'shot',
      'character',
      'location',
      'wikidir',
      'wiki',
      'assetkind',
      'asset',
      'slot',
      'skill',
      'graph',
      'dir',
      'file',
      'more',
    ];
    // The five kinds with nothing to offer contribute no record. Naming them keeps a kind that
    // was covered distinguishable from one that was forgotten.
    const seen = new Set(tree.map((record) => record.when.split(':')[0]));
    const silent: DocNodeKind[] = ['assetkind', 'wiki', 'dir', 'file', 'more'];
    for (const kind of kinds) expect(seen.has(kind)).toBe(!silent.includes(kind));
  });

  it('files every record against the documents editor', () => {
    for (const record of tree) expect(record.editor).toBe('documents');
  });

  // `form: true` is the menu saying it cannot supply an argument, which is the same fact
  // `supplies` states for a drawn box: both mean the palette is where the blank gets filled in.
  it('marks the entries that open the palette on their own form', () => {
    expect(tree.find((record) => record.id === 'art.promote')?.form).toBe(true);
    expect(tree.find((record) => record.id === 'asset.accept')?.form).toBeUndefined();
  });

  it('covers a slice of the catalog no drawn control reaches', () => {
    const built = mapOf(
      tree.map((r) => ({ id: r.id, editor: r.editor, when: r.when }) as AnchorRecord),
    );
    for (const id of ['asset.adopt', 'asset.upload', 'gengraph.createForSlot', 'story.newScene']) {
      expect(built.editorsFor[id]).toEqual(['documents']);
    }
  });
});
