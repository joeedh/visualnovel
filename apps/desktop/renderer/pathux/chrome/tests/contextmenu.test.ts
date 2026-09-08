import type { CommandCheck } from '../../../../src/shared/ipc.js';
import {
  MENU_SEP,
  SEPARATOR,
  entriesWithVerdicts,
  entryKey,
  flatEntries,
  needsCheck,
  type MenuEntry,
} from '../contextmenu.js';

const accept: CommandCheck = { state: 'accept', message: 'Regenerate these bytes' };
const refuse: CommandCheck = { state: 'refuse', message: 'that is `gate.approve`' };
const undeclared: CommandCheck = { state: 'undeclared', message: '' };

describe('needsCheck', () => {
  it('asks for a command that will run', () => {
    expect(needsCheck({ label: 'Accept', id: 'asset.accept' })).toBe(true);
  });

  it('does not ask for a separator', () => {
    expect(needsCheck(SEPARATOR)).toBe(false);
  });

  it('does not ask for an entry that only opens the palette', () => {
    // The entry's props are incomplete on purpose, so a refusal would only name the blank the
    // author is on their way to filling in.
    expect(needsCheck({ label: 'Promote…', id: 'art.promote', form: true })).toBe(false);
  });

  it('does not ask about an entry the surface already refused', () => {
    // The entry names no asset, so a check would have no id to ask a command about.
    expect(
      needsCheck({
        label  : 'Open shot asset',
        id     : 'view.open',
        refused: 'No shot covers a:L1 yet.',
      }),
    ).toBe(false);
  });

  it('does not ask about an effect, a supplied command, or a submenu', () => {
    expect(needsCheck({ label: 'Undo', id: 'history.move', props: { to: 'undo' } })).toBe(false);
    expect(
      needsCheck({ label: 'Create Group', id: 'gengraph.createGroup', supplies: ['slug'] }),
    ).toBe(false);
    expect(
      needsCheck({ label: 'Recent', id: 'menu.open', props: { menu: 'recent' }, submenu: [] }),
    ).toBe(false);
  });
});

describe('entryKey and flatEntries', () => {
  it('keys an entry by its id, and by `on` where it carries one', () => {
    expect(entryKey({ label: 'Undo', id: 'history.move' })).toBe('history.move');
    expect(entryKey({ label: 'Edit Group', id: 'pane.view', on: 'enter' })).toBe('pane.view#enter');
  });

  it('walks submenus in draw order', () => {
    const inner: MenuEntry = { label: 'a', id: 'workspace.open' };
    const outer: MenuEntry = { label: 'Recent', id: 'menu.open', submenu: [inner] };
    expect(flatEntries([outer, SEPARATOR])).toEqual([outer, inner, SEPARATOR]);
  });
});

describe('entriesWithVerdicts', () => {
  const entries: MenuEntry[] = [
    { label: 'Regenerate', id: 'asset.regenerate' },
    { label: 'Accept', id: 'asset.accept' },
    SEPARATOR,
    { label: 'Open elsewhere', id: 'view.open' },
  ];
  const answered = [accept, refuse, undefined, undeclared];

  it('carries an accepted entry through enabled, with its sentence', () => {
    expect(entriesWithVerdicts(entries, answered)[0]).toEqual({
      entry    : entries[0],
      enabled  : true,
      separator: false,
      tooltip  : 'Regenerate these bytes',
    });
  });

  it('greys a refusal rather than hiding it, and keeps the reason', () => {
    const refused = entriesWithVerdicts(entries, answered)[1]!;
    expect(refused.enabled).toBe(false);
    expect(refused.refused).toBe('that is `gate.approve`');
    expect(refused.entry.label).toBe('Accept');
  });

  it('marks a separator, and never asks whether it was refused', () => {
    const sep = entriesWithVerdicts(entries, answered)[2]!;
    expect(sep.separator).toBe(true);
    expect(sep.entry.id).toBe(MENU_SEP);
    expect(sep.tooltip).toBe('');
  });

  it('treats undeclared as neither permission nor refusal', () => {
    const last = entriesWithVerdicts(entries, answered)[3]!;
    expect(last.enabled).toBe(true);
    expect(last.tooltip).toBe('');
  });

  it('leaves an unchecked command enabled and silent', () => {
    const resolved = entriesWithVerdicts(
      [{ label: 'Notes…', id: 'art.setNotes', form: true }],
      [undefined],
    );
    expect(resolved[0]).toMatchObject({ enabled: true, tooltip: '' });
  });

  it('draws a surface’s own refusal exactly like a checked one', () => {
    const resolved = entriesWithVerdicts(
      [{ label: 'Open shot asset', id: 'view.open', refused: 'No shot covers a:L1 yet.' }],
      [undefined],
    );
    expect(resolved[0]).toMatchObject({ enabled: false, refused: 'No shot covers a:L1 yet.' });
  });

  it('lets that refusal stand even where a verdict landed in its slot', () => {
    const resolved = entriesWithVerdicts(
      [{ label: 'Open shot asset', id: 'view.open', refused: 'a:S2 has not been drawn.' }],
      [accept],
    );
    expect(resolved[0]!.enabled).toBe(false);
    expect(resolved[0]!.refused).toBe('a:S2 has not been drawn.');
  });

  it('falls back to what the registry says the command does', () => {
    const says = { 'view.open': 'Show a different editor in this pane' };
    const resolved = entriesWithVerdicts(entries, answered, says);
    // An undeclared verdict carries no message, so the description fills the row instead.
    expect(resolved[3]!.tooltip).toBe('Show a different editor in this pane');
    // A form entry is never checked at all, and gets the same fallback.
    expect(
      entriesWithVerdicts([{ label: 'Open…', id: 'view.open', form: true }], [undefined], says)[0]!
        .tooltip,
    ).toBe('Show a different editor in this pane');
  });

  it('prefers the row’s own sentence to the registry’s, and keeps it beneath a refusal', () => {
    const says = { 'view.open': 'Show a different editor in this pane' };
    const own = { label: 'Set Up API Keys…', id: 'view.open', tooltip: 'How to get a key' };
    expect(entriesWithVerdicts([own], [undeclared], says)[0]!.tooltip).toBe('How to get a key');
    expect(entriesWithVerdicts([own], [refuse], says)[0]).toMatchObject({
      enabled: false,
      tooltip: 'How to get a key',
      refused: 'that is `gate.approve`',
    });
  });

  it('describes an effect row from the effect catalog', () => {
    const says = { 'history.move': 'Moves one step through the command history.' };
    const undo = { label: 'Undo', id: 'history.move', props: { to: 'undo' } };
    expect(entriesWithVerdicts([undo], [undefined], says)[0]!.tooltip).toBe(
      'Moves one step through the command history.',
    );
  });

  it('keeps verdicts positional, so no entry can take its neighbour’s answer', () => {
    const resolved = entriesWithVerdicts(entries, [undefined, undefined, undefined, refuse]);
    expect(resolved.map((item) => item.enabled)).toEqual([true, true, false, false]);
    expect(resolved[3]!.refused).toBe('that is `gate.approve`');
  });
});
