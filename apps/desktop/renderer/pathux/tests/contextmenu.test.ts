import type { CommandCheck } from '../../../src/shared/ipc.js';
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
    // Its props are incomplete on purpose, so the refusal would be about the blank the author is
    // on their way to filling in.
    expect(needsCheck({ label: 'Promote…', id: 'art.promote', form: true })).toBe(false);
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

  it('keeps verdicts positional, so no entry can take its neighbour’s answer', () => {
    const resolved = entriesWithVerdicts(entries, [undefined, undefined, undefined, refuse]);
    expect(resolved.map((item) => item.enabled)).toEqual([true, true, false, false]);
    expect(resolved[3]!.message).toBe('that is `gate.approve`');
  });
});
