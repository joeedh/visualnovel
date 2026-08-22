/**
 * The pure half of the strip's two gestures: which one may start, and the sentence a refused grab
 * is given. Retyping itself lives in `src/shared/lineedit.ts` (what a draft is as a line, what it
 * commits, how a precondition reads), shared with STUDIO's script column.
 *
 * The strip carries two gestures over one grid (dragging a bracket edge and retyping a line) and
 * they cannot be live together. Mid-drag the row under the pointer is read from the DOM and the
 * script column gives up its pointer events, which is exactly what an open editor needs. Each
 * gesture therefore makes the other inert while it lasts (see {@link canEdit} and {@link canGrab}).
 *
 * Every row's text is editable, whatever its kind. The speaker is not: changing who says a line
 * changes its `kind`, and with it the row's shape and the exporter's beat type. `story.setSpeaker`
 * exists and belongs in STUDIO, where the script's structure is what is being edited.
 */
import type { Notice } from '../../../src/shared/lineedit.js';
import { WRITE_PENDING } from './busy.js';

/** What the strip is doing right now. {@link IDLE} is the resting state. */
export interface StripMode {
  /** The line id whose editor is open, or `null`. */
  editing: string | null;
  /** True while a coverage handle, a bracket or a gutter cell is held. */
  dragging: boolean;
  /** True while a command is in flight — the strip is about to be re-read (`busy.ts`). */
  pending: boolean;
}

export const IDLE: StripMode = { editing: null, dragging: false, pending: false };

/**
 * Whether a click may open an editor. Refuses mid-drag, because `.tl-grid.dragging` takes the
 * script column's pointer events away so the hit bands can be reached, and a click that lands
 * nowhere is a better outcome than an editor opening under a held handle. Refuses mid-write,
 * because the row the editor would open over is about to be replaced by the re-read.
 */
export function canEdit(mode: StripMode): boolean {
  return !mode.dragging && !mode.pending;
}

/**
 * Whether a bracket handle may be grabbed. Refuses while an editor is open, and while a write is
 * landing.
 *
 * The rejected alternative was to have entering one gesture close the other: closing an editor
 * commits it (blur commits), so grabbing a handle would silently write a half-typed line and
 * reload the strip under the gesture. Refusing the grab costs the author one click and nothing else.
 */
export function canGrab(mode: StripMode): boolean {
  return mode.editing === null && !mode.pending;
}

/**
 * Whether the strip may be re-read because something outside it rewrote the project — the agent in
 * execute mode, or a command run from the palette. An open editor holds a draft the re-read would
 * carry off with it, and a held handle is aimed at rows the re-read would replace. A write of this
 * pane's own is already followed by a re-read, so re-reading again would double it.
 */
export function canReread(mode: StripMode): boolean {
  return mode.editing === null && !mode.dragging && !mode.pending;
}

/**
 * The sentence a refused grab is given. A write in flight outranks an open editor, because "finish
 * the line" is bad advice while the strip is about to be rebuilt anyway.
 */
export function grabRefusal(mode: StripMode): Notice {
  return mode.pending ? WRITE_PENDING : GRAB_BLOCKED;
}

/**
 * Why a handle does not move while an editor is open. No command was invoked here, so no command
 * supplied this sentence. The handle cannot take focus away from the editor (its `pointerdown` is
 * prevented, so there is no blur and no commit), so without this notice the click reads as a
 * broken drag.
 */
export const GRAB_BLOCKED: Notice = {
  tone: 'refused',
  text: 'Finish the line first — Enter commits it, Escape discards it.',
};
