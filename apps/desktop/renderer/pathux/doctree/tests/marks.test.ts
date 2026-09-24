import {
  NO_MARKS,
  markClick,
  menuTargets,
  movedId,
  pruneMarks,
  remapMarks,
  revealMarks,
} from '../marks.js';
import type { DocRow } from '../doctree.js';
import type { DocNode } from '../../../../src/shared/ipc.js';

const row = (id: string, kind: DocNode['kind'], path?: string): DocRow => ({
  node      : { id, kind, label: id, ...(path === undefined ? {} : { path }) },
  depth     : 0,
  expandable: false,
  expanded  : false,
});

// Draw order of a file-mode tree: a root folder, two pages, a folder outside the roots and a file
// in it, then a folder and a page back under wiki/
const ROOT = row('dir:wiki', 'dir', 'wiki');
const A = row('file:wiki/a.md', 'file', 'wiki/a.md');
const B = row('file:wiki/b.md', 'file', 'wiki/b.md');
const SCENES = row('dir:scenes', 'dir', 'scenes');
const SCENE = row('file:scenes/x.md', 'file', 'scenes/x.md');
const LORE = row('dir:wiki/lore', 'dir', 'wiki/lore');
const C = row('file:wiki/lore/c.md', 'file', 'wiki/lore/c.md');
const ROWS = [ROOT, A, B, SCENES, SCENE, LORE, C];

const PLAIN = { ctrl: false, shift: false };
const CTRL = { ctrl: true, shift: false };
const SHIFT = { ctrl: false, shift: true };

describe('markClick', () => {
  it('marks the row alone on a plain click, and the click still does what it did', () => {
    const state = { marks: ['file:wiki/b.md'], anchor: 'file:wiki/b.md' };
    expect(markClick(state, A, ROWS, PLAIN)).toEqual({
      next : { marks: ['file:wiki/a.md'], anchor: 'file:wiki/a.md' },
      plain: true,
    });
  });

  it('toggles the row on a Ctrl-click, in click order, and does nothing else', () => {
    const one = markClick(NO_MARKS, B, ROWS, CTRL);
    expect(one).toEqual({
      next : { marks: ['file:wiki/b.md'], anchor: 'file:wiki/b.md' },
      plain: false,
    });
    const two = markClick(one.next, A, ROWS, CTRL);
    expect(two.next).toEqual({
      marks : ['file:wiki/b.md', 'file:wiki/a.md'],
      anchor: 'file:wiki/a.md',
    });
    expect(markClick(two.next, B, ROWS, CTRL).next).toEqual({
      marks : ['file:wiki/a.md'],
      anchor: 'file:wiki/b.md',
    });
  });

  it('marks the range from the anchor on a Shift-click, skipping rows that cannot be marked', () => {
    const state = { marks: ['file:wiki/a.md'], anchor: 'file:wiki/a.md' };
    const range = markClick(state, C, ROWS, SHIFT);
    expect(range).toEqual({
      next: {
        marks : ['file:wiki/a.md', 'file:wiki/b.md', 'dir:wiki/lore', 'file:wiki/lore/c.md'],
        anchor: 'file:wiki/a.md',
      },
      plain: false,
    });
    // A second Shift-click from the same anchor replaces the range rather than adding to it
    expect(markClick(range.next, B, ROWS, SHIFT).next.marks).toEqual([
      'file:wiki/a.md',
      'file:wiki/b.md',
    ]);
    const upwards = { marks: [], anchor: 'file:wiki/lore/c.md' };
    expect(markClick(upwards, B, ROWS, SHIFT).next.marks).toEqual([
      'file:wiki/b.md',
      'dir:wiki/lore',
      'file:wiki/lore/c.md',
    ]);
  });

  it('treats a Shift-click with no anchor drawn as a plain click', () => {
    const gone = { marks: [], anchor: 'file:wiki/gone.md' };
    expect(markClick(gone, B, ROWS, SHIFT)).toEqual({
      next : { marks: ['file:wiki/b.md'], anchor: 'file:wiki/b.md' },
      plain: true,
    });
  });

  it('clears the marks on any click on a row that cannot be marked', () => {
    const state = { marks: ['file:wiki/a.md', 'file:wiki/b.md'], anchor: 'file:wiki/a.md' };
    for (const mods of [PLAIN, CTRL, SHIFT]) {
      expect(markClick(state, SCENE, ROWS, mods)).toEqual({ next: NO_MARKS, plain: true });
    }
    const heading = row('branch:wiki', 'branch');
    expect(markClick(state, heading, ROWS, CTRL)).toEqual({ next: NO_MARKS, plain: true });
  });
});

describe('menuTargets', () => {
  const two = { marks: ['file:wiki/a.md', 'file:wiki/b.md'], anchor: 'file:wiki/b.md' };

  it('keeps every mark when the row is one of several marked', () => {
    expect(menuTargets(two, A)).toEqual({ next: two, targets: two.marks });
  });

  it('makes any other markable row the only mark', () => {
    const only = { marks: ['file:wiki/lore/c.md'], anchor: 'file:wiki/lore/c.md' };
    expect(menuTargets(two, C)).toEqual({ next: only, targets: ['file:wiki/lore/c.md'] });
    // A row marked alone is not "one of several"
    expect(menuTargets(only, C)).toEqual({ next: only, targets: ['file:wiki/lore/c.md'] });
  });

  it('clears the marks for a row that cannot be marked', () => {
    expect(menuTargets(two, SCENE)).toEqual({ next: NO_MARKS, targets: ['file:scenes/x.md'] });
  });
});

describe('pruneMarks', () => {
  const state = { marks: ['file:wiki/a.md', 'file:wiki/lore/c.md'], anchor: 'file:wiki/lore/c.md' };

  it('keeps the same state when every mark is still drawn', () => {
    expect(pruneMarks(state, ROWS)).toBe(state);
  });

  it('drops marks and the anchor on rows a refetch, a filter or a collapse took away', () => {
    const filtered = [ROOT, A, LORE];
    expect(pruneMarks(state, filtered)).toEqual({ marks: ['file:wiki/a.md'], anchor: '' });
    expect(pruneMarks(state, [])).toEqual(NO_MARKS);
  });
});

describe('revealMarks', () => {
  it('marks the drawn rows at the revealed paths, in draw order, the last as anchor', () => {
    expect(revealMarks(ROWS, ['wiki/lore/c.md', 'wiki/a.md'])).toEqual({
      marks : ['file:wiki/a.md', 'file:wiki/lore/c.md'],
      anchor: 'file:wiki/lore/c.md',
    });
  });

  it('marks nothing for a path that is not drawn or cannot be marked', () => {
    expect(revealMarks(ROWS, ['wiki/gone.md', 'scenes/x.md'])).toEqual(NO_MARKS);
  });
});

describe('remapMarks', () => {
  const moves = [
    { from: 'wiki/a.md', to: 'wiki/lore/a.md' },
    { from: 'wiki/old', to: 'archive/old' },
  ];

  it('carries file-mode ids to the new paths, a folder’s contents with it', () => {
    const state = {
      marks : ['file:wiki/a.md', 'dir:wiki/old', 'file:wiki/old/n.md'],
      anchor: 'file:wiki/a.md',
    };
    expect(remapMarks(state, moves)).toEqual({
      marks : ['file:wiki/lore/a.md', 'dir:archive/old', 'file:archive/old/n.md'],
      anchor: 'file:wiki/lore/a.md',
    });
  });

  it('carries document-mode ids, which name a path under wiki/', () => {
    const state = { marks: ['wiki:a.md', 'wikidir:lore'], anchor: 'wikidir:lore' };
    expect(remapMarks(state, [...moves, { from: 'wiki/lore', to: 'wiki/places/lore' }])).toEqual({
      marks : ['wiki:lore/a.md', 'wikidir:places/lore'],
      anchor: 'wikidir:places/lore',
    });
  });

  it('leaves an id it cannot carry, and one no move names, for the next redraw to judge', () => {
    // A page moved out of wiki/ has no row in the Wiki branch, so its id is left to be pruned
    expect(movedId('wikidir:old', moves)).toBe('wikidir:old');
    expect(movedId('file:wiki/b.md', moves)).toBe('file:wiki/b.md');
    expect(movedId('branch:wiki', moves)).toBe('branch:wiki');
    expect(remapMarks(NO_MARKS, moves)).toEqual(NO_MARKS);
  });
});
