/**
 * Retyping one line, in the two surfaces that offer it: the Shot Coverage timeline and the
 * Script editor's lines. Both open a textarea over a row and both commit `story.setLineText`, so
 * the decisions here are made once rather than twice: what a draft amounts to as a line, whether
 * an edit happened at all, and how a precondition reads.
 *
 * It is in `shared/` because the two consumers live in separate directories, and neither may
 * reach into the other's to reuse a rule. Nothing here writes: a caller gets an `Invocation` and
 * runs it through the command stack like every other mutation.
 */
import type { Invocation, Verdict } from '@vn/commands';
import type { CommandCheck, CoverageLine } from './ipc.js';

/**
 * A draft folded to what a single line can hold. The editor is a textarea so the row grows as
 * you type, which also means it accepts a pasted newline, and a line with a newline in it is not
 * one line. Folding those newlines is the only change made to the text; whether the result is
 * allowed is `@vn/scriptedit`'s decision, never this module's.
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
 * The question is whether an act happened: clicking into a line and clicking away must not leave
 * a `CommandRecord` and an undo point that undo nothing. Every other judgment — an empty line, a
 * text that would not read back — belongs to the command, and its sentence is what gets shown.
 */
export function commitOf(line: CoverageLine, draft: string): Invocation | null {
  const text = lineOf(draft);
  if (text === lineOf(line.text)) return null;
  return { id: 'story.setLineText', props: { line: line.id, text } };
}

/**
 * A one-line message above the rows. `preview` says what would happen; `ok` and `refused` say
 * what did happen.
 *
 * Both ways a command reports before it runs produce this same type — a `check` asked while the
 * author types, and a `Verdict` judged while something is carried — so the two surfaces cannot
 * disagree about which one reads as a warning.
 */
export interface Notice {
  tone: 'ok' | 'refused' | 'preview';
  text: string;
}

/**
 * What a command's precondition says, as the author reads it before committing — the count of
 * rendered shots that will keep illustrating the old prose comes from the command's own `check`,
 * so the warning and the run's message are one sentence rather than two guesses.
 *
 * An `undeclared` check renders as nothing, because a command that states no precondition has
 * not accepted.
 */
export function noticeForCheck(check: CommandCheck): Notice | null {
  if (check.state === 'undeclared') return null;
  return check.state === 'accept'
    ? { tone: 'preview', text: check.message }
    : { tone: 'refused', text: check.message };
}

/**
 * A notice for a gesture in flight, built from the verdict's own sentence, so what the author
 * reads while carrying something is what the command would have said on a drop.
 */
export function noticeForVerdict(verdict: Verdict): Notice {
  return verdict.accept
    ? { tone: 'preview', text: verdict.note }
    : { tone: 'refused', text: verdict.reason };
}
