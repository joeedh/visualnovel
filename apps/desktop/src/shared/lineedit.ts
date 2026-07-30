/**
 * Retyping one line, in the two surfaces that offer it: FLOOR's coverage timeline and STUDIO's
 * script column. Both open a textarea over a row and both commit `story.setLineText`, so the
 * decisions here — what a draft *is* as a line, whether an edit happened at all, how a
 * precondition reads — are made once rather than twice.
 *
 * It is in `shared/` because the two consumers are in different rooms, and a room reaching into
 * another room's directory is how two copies of a rule start. Nothing here writes: a caller gets
 * an `Invocation` and runs it through the command stack like every other mutation.
 */
import type { Invocation } from '@vn/commands';
import type { CommandCheck, CoverageLine } from './ipc.js';

/**
 * A draft as a line can hold it. The editor is a textarea so the row grows as you type, which
 * also means it accepts a pasted newline — and a line with a newline in it is not one line.
 * Folding those is the only quiet change this makes; the rest of the text is the author's, and
 * whether it is *allowed* is `@vn/scriptedit`'s to say, never this module's.
 */
export function lineOf(draft: string): string {
  return draft.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * The invocation a finished edit commits, or `null` when the draft says what the line already
 * says.
 *
 * The no-op is decided here rather than in main because it is not a question about legality —
 * `story.setLineText` handles an unchanged text perfectly well ("already reads that way").
 * It is whether an *act* happened: clicking into a line and clicking away must not leave a
 * `CommandRecord` and an undo point that undo nothing. Every other judgment — an empty line, a
 * text that would not read back — belongs to the command, and its sentence is what gets shown.
 */
export function commitOf(line: CoverageLine, draft: string): Invocation | null {
  const text = lineOf(draft);
  if (text === lineOf(line.text)) return null;
  return { id: 'story.setLineText', props: { line: line.id, text } };
}

/** A one-line message above the rows. `preview` is what would happen; `ok`/`refused` did. */
export interface Notice {
  tone: 'ok' | 'refused' | 'preview';
  text: string;
}

/**
 * What a command's precondition says, as the author reads it before committing — the count of
 * rendered shots that will keep illustrating the old prose comes from the command's own `check`,
 * so the warning and the run's message are one sentence rather than two guesses.
 *
 * `undeclared` renders as nothing: a command that states no precondition has not said yes.
 */
export function noticeForCheck(check: CommandCheck): Notice | null {
  if (check.state === 'undeclared') return null;
  return check.state === 'accept'
    ? { tone: 'preview', text: check.message }
    : { tone: 'refused', text: check.message };
}
