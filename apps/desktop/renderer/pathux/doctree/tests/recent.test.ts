import { RECENT_LIMIT, RecentPages, stepRow } from '../recent.js';

describe('RecentPages', () => {
  it('keeps the pages most recent first, each once', () => {
    const recent = new RecentPages();
    for (const path of ['wiki/a.md', 'wiki/b.md', 'wiki/c.md', 'wiki/a.md']) recent.visit(path);
    expect(recent.paths).toEqual(['wiki/a.md', 'wiki/c.md', 'wiki/b.md']);
  });

  it('ignores the empty path, which is no document', () => {
    const recent = new RecentPages();
    recent.visit('wiki/a.md');
    recent.visit('');
    expect(recent.paths).toEqual(['wiki/a.md']);
  });

  it('drops the oldest page past its limit', () => {
    const recent = new RecentPages(3);
    for (const path of ['a.md', 'b.md', 'c.md', 'd.md']) recent.visit(path);
    expect(recent.paths).toEqual(['d.md', 'c.md', 'b.md']);
    expect(RECENT_LIMIT).toBeGreaterThan(3);
  });

  it('follows a rename and a folder move without losing the order', () => {
    const recent = new RecentPages();
    for (const path of ['wiki/lore/b.md', 'notes.md', 'wiki/a.md']) recent.visit(path);
    recent.moved([
      { from: 'wiki/a.md', to: 'wiki/z.md' },
      { from: 'wiki/lore', to: 'wiki/old' },
    ]);
    expect(recent.paths).toEqual(['wiki/z.md', 'notes.md', 'wiki/old/b.md']);
  });

  it('keeps one entry when a move lands a page on another the list holds', () => {
    const recent = new RecentPages();
    for (const path of ['b.md', 'a.md']) recent.visit(path);
    recent.moved([{ from: 'b.md', to: 'a.md' }]);
    expect(recent.paths).toEqual(['a.md']);
  });

  it('forgets a page', () => {
    const recent = new RecentPages();
    for (const path of ['a.md', 'b.md']) recent.visit(path);
    recent.forget('a.md');
    expect(recent.paths).toEqual(['b.md']);
  });
});

describe('stepRow', () => {
  it('steps and wraps at either end', () => {
    expect(stepRow(0, 1, 3)).toBe(1);
    expect(stepRow(2, 1, 3)).toBe(0);
    expect(stepRow(0, -1, 3)).toBe(2);
    expect(stepRow(0, 1, 0)).toBe(0);
  });
});
