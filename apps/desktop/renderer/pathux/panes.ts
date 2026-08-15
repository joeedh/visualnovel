/**
 * Which pane a `view.*` command means. Pure arithmetic over a description of the mesh, so the
 * choice a command makes can be tested without a screen.
 *
 * "The active pane" is where the pointer last was, which is right almost always and wrong in
 * exactly one case: the header, which the pointer crosses on its way to a menu. Chrome is
 * therefore never a candidate, and a mesh whose only pane is chrome has no answer at all.
 */

/** One screen area, reduced to what a choice depends on. */
export interface Pane {
  /** The area name of the editor it shows — `''` for an area with no editor yet. */
  editor: string;
  /** Chrome (the header) rather than somewhere the author navigates to. */
  chrome: boolean;
  active: boolean;
  width: number;
  height: number;
}

/** No pane. Returned rather than thrown: every caller has something to say about it. */
export const NO_PANE = -1;

/** The pane showing an editor, or `NO_PANE`. The first, if the author opened two. */
export function paneShowing(panes: readonly Pane[], editor: string): number {
  return panes.findIndex((pane) => !pane.chrome && pane.editor === editor);
}

/**
 * The pane an `open` lands in: the active one, or — when the pointer is over chrome, or nowhere
 * at all — the biggest, which is the one the author is most likely looking at.
 */
export function paneToUse(panes: readonly Pane[]): number {
  const usable = panes.filter((pane) => !pane.chrome);
  if (usable.length === 0) return NO_PANE;

  const active = panes.findIndex((pane) => !pane.chrome && pane.active);
  if (active !== NO_PANE) return active;

  const biggest = usable.reduce((a, b) => (area(b) > area(a) ? b : a));
  return panes.indexOf(biggest);
}

/**
 * The pane an `open(where='elsewhere')` lands in: the biggest non-chrome pane that is not the one
 * asking. `NO_PANE` when there is no other — a window with one pane has nowhere else, and the
 * caller splits instead. Never chrome, so a two-pane window with a header still has an answer.
 */
export function paneElsewhere(panes: readonly Pane[], from: number): number {
  const others = panes.filter((pane, index) => !pane.chrome && index !== from);
  if (others.length === 0) return NO_PANE;
  return panes.indexOf(others.reduce((a, b) => (area(b) > area(a) ? b : a)));
}

/**
 * The pane a `close` collapses. The last non-chrome pane is kept: a mesh of nothing but the
 * header is a window with no way back, and refusing is friendlier than emptying the screen.
 */
export function paneToClose(panes: readonly Pane[]): number {
  if (panes.filter((pane) => !pane.chrome).length < 2) return NO_PANE;
  return paneToUse(panes);
}

const area = (pane: Pane): number => pane.width * pane.height;
