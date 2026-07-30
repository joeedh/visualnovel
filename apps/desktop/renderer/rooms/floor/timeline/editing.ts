/**
 * The pure half of the *strip's* two gestures: which one may start, and the one sentence a
 * refused grab has to say. Retyping itself — what a draft is as a line, what it commits, how a
 * precondition reads — is `src/shared/lineedit.ts`, shared with STUDIO's script column.
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
import type { Notice } from '../../../../src/shared/lineedit.js';

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
 * Why a handle does not move while an editor is open — and the one sentence in this strip that no
 * command said, because no command was asked. A refused grab has to say something: the handle
 * cannot take focus away from the editor (its `pointerdown` is prevented, so no blur, so no
 * commit), which means without this the click reads as the drag being broken.
 */
export const GRAB_BLOCKED: Notice = {
  tone: 'refused',
  text: 'Finish the line first — Enter commits it, Escape discards it.',
};
