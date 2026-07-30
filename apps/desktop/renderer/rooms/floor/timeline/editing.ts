/**
 * The pure half of in-place line editing: which of the strip's two gestures may start, what a
 * finished edit asks for, and how a precondition's answer reads.
 *
 * The strip carries two gestures over one grid — dragging a bracket edge and retyping a line —
 * and they cannot be live together: mid-drag the row under the pointer is read from the DOM and
 * the script column gives up its pointer events, which is exactly what an open editor needs.
 * So each one makes the other inert while it lasts (see {@link canEdit} / {@link canGrab}).
 *
 * Every row's *text* is editable, whatever its kind. The speaker is not: changing who says a
 * line changes its `kind`, hence the row's shape and the exporter's beat type. `story.setSpeaker`
 * exists and belongs in STUDIO, where the script's structure is what you are editing.
 */
import type { Invocation } from '@vn/commands';
import type { CommandCheck, CoverageLine } from '../../../../src/shared/ipc';

/** What the strip is doing right now. Both idle is the resting state. */
export interface StripMode {
  /** The line id whose editor is open, or `null`. */
  editing: string | null;
  /** True while a coverage handle is held. */
  dragging: boolean;
}

export const IDLE: StripMode = { editing: null, dragging: false };

/**
 * May a click open an editor? Not mid-drag: `.tl-grid.dragging` takes the script column's
 * pointer events away so the hit bands can be reached, and a click that lands nowhere is a
 * better outcome than an editor opening under a held handle.
 */
export function canEdit(mode: StripMode): boolean {
  return !mode.dragging;
}

/**
 * May a bracket handle be grabbed? Not while an editor is open.
 *
 * The plan's first answer was "entering one closes the other", which is worse: closing an editor
 * commits it (blur commits), so grabbing a handle would silently write a half-typed line and
 * reload the strip under the gesture. Refusing the grab costs the author one click and nothing else.
 */
export function canGrab(mode: StripMode): boolean {
  return mode.editing === null;
}

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

/** A one-line message above the strip. `preview` is what would happen; `ok`/`refused` did. */
export interface Notice {
  tone: 'ok' | 'refused' | 'preview';
  text: string;
}

/**
 * Why a handle does not move while an editor is open — and the one sentence in this strip that no
 * command said, because no command was asked. A refused grab has to say something: the handle
 * cannot take focus away from the editor (its `pointerdown` is prevented, so no blur, so no
 * commit), which means without this the click reads as the drag being broken.
 */
export const GRAB_BLOCKED: Notice = {
  tone: 'refused',
  text: 'Finish the line first — Enter commits it, Escape discards it.',
};

/**
 * What `story.setLineText`'s precondition says, as the author reads it before committing — the
 * count of rendered shots that will keep illustrating the old prose comes from the command's own
 * `check`, so the warning and the run's message are one sentence rather than two guesses.
 *
 * `undeclared` renders as nothing: a command that states no precondition has not said yes.
 */
export function noticeForCheck(check: CommandCheck): Notice | null {
  if (check.state === 'undeclared') return null;
  return check.state === 'accept'
    ? { tone: 'preview', text: check.message }
    : { tone: 'refused', text: check.message };
}
