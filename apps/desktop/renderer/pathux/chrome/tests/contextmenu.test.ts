import type { CommandCheck } from '../../../../src/shared/ipc.js';
import { MENU_SEP, entriesWithVerdicts, needsCheck, type MenuEntry } from '../contextmenu.js';

const accept: CommandCheck = { state: 'accept', message: 'Regenerate these bytes' };
const refuse: CommandCheck = { state: 'refuse', message: 'that is `gate.approve`' };
const undeclared: CommandCheck = { state: 'undeclared', message: '' };

describe('needsCheck', () => {
  it('asks for a command that will run', () => {
    expect(needsCheck({ label: 'Accept', id: 'asset.accept' })).toBe(true);
  });

  it('does not ask for a separator', () => {
    expect(needsCheck({ label: MENU_SEP, id: MENU_SEP })).toBe(false);
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
        label: 'Open shot asset',
        id: 'view.open',
        refused: 'No shot covers a:L1 yet.',
      }),
    ).toBe(false);
  });
});

describe('entriesWithVerdicts', () => {
  const entries: MenuEntry[] = [
    { label: 'Regenerate', id: 'asset.regenerate' },
    { label: 'Accept', id: 'asset.accept' },
    { label: MENU_SEP, id: MENU_SEP },
    { label: 'Open elsewhere', id: 'view.open' },
  ];
  const answered = [accept, refuse, undefined, undeclared];

  it('carries an accepted entry through unmarked, with its sentence', () => {
    expect(entriesWithVerdicts(entries, answered)[0]).toMatchObject({
      label: 'Regenerate',
      enabled: true,
      separator: false,
      message: 'Regenerate these bytes',
    });
  });

  it('shows a refusal rather than hiding it, and keeps the reason', () => {
    const refused = entriesWithVerdicts(entries, answered)[1]!;
    expect(refused.enabled).toBe(false);
    expect(refused.label).toContain('Accept');
    expect(refused.label).not.toBe('Accept');
    expect(refused.message).toBe('that is `gate.approve`');
  });

  it('marks a separator, and never asks whether it was refused', () => {
    const sep = entriesWithVerdicts(entries, answered)[2]!;
    expect(sep.separator).toBe(true);
    expect(sep.label).toBe(MENU_SEP);
    expect(sep.message).toBe('');
  });

  it('treats undeclared as neither permission nor refusal', () => {
    const last = entriesWithVerdicts(entries, answered)[3]!;
    expect(last.enabled).toBe(true);
    expect(last.message).toBe('');
  });

  it('leaves an unchecked command enabled and silent', () => {
    const resolved = entriesWithVerdicts(
      [{ label: 'Notes…', id: 'art.setNotes', form: true }],
      [undefined],
    );
    expect(resolved[0]).toMatchObject({ label: 'Notes…', enabled: true, message: '' });
  });

  it('draws a surface’s own refusal exactly like a checked one', () => {
    const resolved = entriesWithVerdicts(
      [{ label: 'Open shot asset', id: 'view.open', refused: 'No shot covers a:L1 yet.' }],
      [undefined],
    );
    const only = resolved[0]!;
    expect(only.enabled).toBe(false);
    expect(only.label).toContain('Open shot asset');
    expect(only.label).not.toBe('Open shot asset');
    expect(only.message).toBe('No shot covers a:L1 yet.');
  });

  it('lets that refusal stand even where a verdict landed in its slot', () => {
    const resolved = entriesWithVerdicts(
      [{ label: 'Open shot asset', id: 'view.open', refused: 'a:S2 has not been drawn.' }],
      [accept],
    );
    expect(resolved[0]!.enabled).toBe(false);
    expect(resolved[0]!.message).toBe('a:S2 has not been drawn.');
  });

  it('falls back to what the registry says the command does', () => {
    const says = { 'view.open': 'Show a different editor in this pane' };
    const resolved = entriesWithVerdicts(entries, answered, says);
    // An undeclared verdict carries no message, so the description fills the row instead.
    expect(resolved[3]!.message).toBe('Show a different editor in this pane');
    // A form entry is never checked at all, and gets the same fallback.
    expect(
      entriesWithVerdicts([{ label: 'Open…', id: 'view.open', form: true }], [undefined], says)[0]!
        .message,
    ).toBe('Show a different editor in this pane');
  });

  it('prefers a refusal to the description, because the refusal is the news', () => {
    const says = { 'asset.accept': 'Mark this asset approved' };
    expect(entriesWithVerdicts(entries, answered, says)[1]!.message).toBe('that is `gate.approve`');
  });

  it('keeps verdicts positional, so no entry can take its neighbour’s answer', () => {
    const resolved = entriesWithVerdicts(entries, [undefined, undefined, undefined, refuse]);
    expect(resolved.map((item) => item.enabled)).toEqual([true, true, false, false]);
    expect(resolved[3]!.message).toBe('that is `gate.approve`');
  });
});
