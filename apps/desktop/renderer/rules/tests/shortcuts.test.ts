import {
  MODS,
  SHORTCUTS,
  bindings,
  comboOf,
  findShortcut,
  matches,
  shortcutOf,
  shortcutRecords,
} from '../shortcuts.js';
import { move, openPopup, view } from '../effects.js';
import { EDITOR_IDS } from '../../../src/shared/editors.js';
import { UX_SHORTCUT } from '../../../src/shared/uxmodel.js';

const combo = (entry: { key: string; mods: readonly string[] }) =>
  `${[...entry.mods].sort().join('+')} ${entry.key}`;

describe('SHORTCUTS', () => {
  it('parses entry by entry', () => {
    for (const entry of shortcutRecords()) expect(() => UX_SHORTCUT.parse(entry)).not.toThrow();
  });

  it('scopes every entry to the shell, main or an editor', () => {
    for (const entry of SHORTCUTS) {
      expect(['global', 'main', ...EDITOR_IDS]).toContain(entry.scope);
    }
  });

  it('binds each combination once in a scope', () => {
    const seen = new Set<string>();
    for (const entry of SHORTCUTS) {
      const key = `${entry.scope} ${combo(entry)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('lets an editor take a shell combination only by shadowing it', () => {
    const shell = new Set(SHORTCUTS.filter((e) => e.scope === 'global').map(combo));
    for (const entry of SHORTCUTS) {
      if (entry.scope === 'global' || entry.scope === 'main') continue;
      expect(entry.shadows === true).toBe(shell.has(combo(entry)));
    }
  });

  it('uses only the modifiers a combo can spell', () => {
    for (const entry of SHORTCUTS) {
      for (const mod of entry.mods) expect(MODS).toContain(mod);
    }
  });

  it('marks the Gen Graph scope as path.ux’s and nothing else', () => {
    for (const entry of SHORTCUTS) {
      expect(entry.from === 'pathux').toBe(entry.scope === 'gengraph');
    }
  });
});

describe('comboOf and shortcutOf', () => {
  it('spells a combo the way the header rows read', () => {
    expect(comboOf({ key: 'P', mods: ['shift', 'ctrl'] })).toBe('Ctrl+Shift+P');
    expect(comboOf({ key: 'G', mods: ['alt', 'ctrl'] })).toBe('Ctrl+Alt+G');
    expect(comboOf({ key: 'Tab', mods: [] })).toBe('Tab');
  });

  it('finds the first binding for what a control does', () => {
    expect(shortcutOf(openPopup('palette'))).toBe('Ctrl+Shift+P');
    expect(shortcutOf(move('undo'))).toBe('Ctrl+Z');
    expect(shortcutOf(move('redo'))).toBe('Ctrl+Shift+Z');
    expect(shortcutOf(view('scope'), 'enter')).toBe('Tab');
    expect(shortcutOf({ id: 'agent.setMode', props: { mode: 'plan' } })).toBe('Shift+Tab');
    expect(shortcutOf({ id: 'gengraph.createGroup', props: { slug: 'plates' } })).toBe('Ctrl+G');
  });

  it('throws for an action nothing binds, since a label is a claim', () => {
    expect(() => shortcutOf({ id: 'story.newScene', props: {} })).toThrow(/no shortcut is bound/);
    expect(() => shortcutOf(view('scope'), 'leave')).toThrow(/pane.view#leave/);
  });

  it('matches by id, `on` and the props the entry names', () => {
    const undo = SHORTCUTS.find((e) => e.label === 'Undo')!;
    expect(matches(undo, move('undo'))).toBe(true);
    expect(matches(undo, move('redo'))).toBe(false);
    expect(matches(undo, { id: 'history.move' })).toBe(false);
    const edit = SHORTCUTS.find((e) => e.label === 'Edit Group')!;
    expect(matches(edit, view('scope'), 'enter')).toBe(true);
    expect(matches(edit, view('scope'), 'exit')).toBe(false);
    expect(matches(edit, view('scope'))).toBe(false);
    const remove = SHORTCUTS.find((e) => e.label === 'Delete')!;
    expect(matches(remove, { id: 'gengraph.removeNode' })).toBe(true);
  });

  it('matches a family when the entry’s `on` ends in a slash', () => {
    const nudge = SHORTCUTS.find((e) => e.label === 'Nudge left')!;
    expect(matches(nudge, { id: 'story.setPanels' }, 'corner/2/3')).toBe(true);
    expect(matches(nudge, { id: 'story.setPanels' }, 'layout/two-tier')).toBe(false);
    expect(matches(nudge, { id: 'story.setPanels' })).toBe(false);
    expect(shortcutOf({ id: 'story.setPanels', props: {} }, 'corner/1/1')).toBe('Left');
  });

  it('looks in the editor’s scope and the shell’s when an editor is named', () => {
    const group = { id: 'gengraph.createGroup', props: {} };
    expect(findShortcut(group, undefined, 'gengraph')?.scope).toBe('gengraph');
    expect(findShortcut(group, undefined, 'script')).toBeUndefined();
    expect(findShortcut(move('undo'), undefined, 'script')?.scope).toBe('global');
    expect(findShortcut(group)?.scope).toBe('gengraph');
  });
});

describe('bindings', () => {
  const noop = () => {};

  it('pairs each entry with its handler by label, in table order', () => {
    const list = bindings('play', { Advance: noop, Back: noop });
    expect(list.map((b) => [b.key, b.label, b.run])).toEqual([
      ['Space', 'Advance', noop],
      ['Enter', 'Advance', noop],
      ['Right', 'Advance', noop],
      ['Left', 'Back', noop],
      ['Backspace', 'Back', noop],
    ]);
  });

  it('throws on a missing handler and on a handler no entry names', () => {
    expect(() => bindings('play', { Advance: noop })).toThrow(/no handler for \["Back"\]/);
    expect(() => bindings('play', { Advance: noop, Back: noop, Skip: noop })).toThrow(
      /no entry for \["Skip"\]/,
    );
  });

  it('has nothing to bind for a scope path.ux binds itself', () => {
    expect(bindings('gengraph', {})).toEqual([]);
  });

  it('covers the shell with eleven handlers', () => {
    const labels = [...new Set(SHORTCUTS.filter((e) => e.scope === 'global').map((e) => e.label))];
    expect(labels).toHaveLength(11);
    const list = bindings('global', Object.fromEntries(labels.map((label) => [label, noop])));
    expect(list).toHaveLength(12);
  });
});
