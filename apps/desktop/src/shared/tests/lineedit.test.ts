import { commitOf, lineOf, noticeForCheck } from '../lineedit.js';
import type { CoverageLine } from '../ipc.js';

const line: CoverageLine = { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' };

describe('lineOf', () => {
  it('folds a pasted newline, because a line with a newline in it is not one line', () => {
    expect(lineOf('Um… hello.\n\n  You came.')).toBe('Um… hello. You came.');
  });

  it('leaves the author’s own spacing alone', () => {
    expect(lineOf('  She bows,  a little too deeply.  ')).toBe('She bows,  a little too deeply.');
  });
});

describe('commitOf', () => {
  it('asks for the retype the author typed', () => {
    expect(commitOf(line, 'Um… hi.')).toEqual({
      id   : 'story.setLineText',
      props: { line: 's:L2', text: 'Um… hi.' },
    });
  });

  // A click in and a click away is not an authorial act, so it must not leave an undo point that
  // undoes nothing
  it('asks for nothing when the draft says what the line already says', () => {
    expect(commitOf(line, 'Um… hello.')).toBeNull();
    expect(commitOf(line, '  Um… hello. ')).toBeNull();
  });

  /**
   * An empty draft still commits. `@vn/scriptedit` is the authority on whether a line may be
   * empty ("delete it instead") and reproducing that rule here would be a second copy of it —
   * the author reads the command's own refusal instead.
   */
  it('sends an emptied line rather than deciding it locally', () => {
    expect(commitOf(line, '   ')).toEqual({
      id   : 'story.setLineText',
      props: { line: 's:L2', text: '' },
    });
  });
});

describe('noticeForCheck', () => {
  it('shows the command’s own sentence, whichever way it went', () => {
    expect(
      noticeForCheck({ state: 'accept', message: '1 rendered shot(s) will not re-render.' })?.tone,
    ).toBe('preview');
    expect(noticeForCheck({ state: 'refuse', message: 'No line "s:L9".' })).toEqual({
      tone: 'refused',
      text: 'No line "s:L9".',
    });
  });

  it('shows nothing for undeclared — no check is not a yes', () => {
    expect(
      noticeForCheck({ state: 'undeclared', message: '(preview) no command stack' }),
    ).toBeNull();
  });
});
