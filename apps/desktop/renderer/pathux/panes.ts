/**
 * Which pane a `view.*` command means. Pure arithmetic over a description of the mesh, so the
 * choice a command makes can be tested without a screen.
 *
 * "The active pane" is where the pointer last was, which is right almost always and wrong in
 * exactly one case: the header, which the pointer crosses on its way to a menu. Chrome is
 * therefore never a candidate, and a mesh whose only pane is chrome has no answer at all.
 */
import type { EditorId } from '../../src/shared/editors.js';

/**
 * The one editor an automatic open steps around. A conversation is the only pane whose contents
 * the author *wrote* — everything else redraws from the project, so covering it costs a scroll
 * position at worst, while covering a transcript mid-turn hides the answer they are waiting for.
 * A preference, never a rule: a mesh with nowhere else still opens over it.
 */
const SPOKEN_IN: EditorId = 'convo';

/** One screen area, reduced to what a choice depends on. */
export interface Pane {
  /** The area name of the editor it shows — `''` for an area with no editor yet. */
  editor: string;
  /** Chrome (the header) rather than somewhere the author navigates to. */
  chrome: boolean;
  /**
   * A floating popup window rather than a tile in the mesh.
   *
   * It is on screen and it shows an editor, so {@link paneShowing} finds it — asking for the
   * Tasks editor while a Tasks popup is up means that one. Everything else here is about
   * arranging the mesh, and a popup is not in the mesh: splitting one, collapsing one, or
   * covering one with a different editor are all things the author never asked for.
   */
  floating: boolean;
  active: boolean;
  width: number;
  height: number;
}

/** Whether this pane is a tile the arranging rules below may move, split, cover or collapse. */
function arrangeable(pane: Pane): boolean {
  return !pane.chrome && !pane.floating;
}

/** No pane. Returned rather than thrown: every caller has something to say about it. */
export const NO_PANE = -1;

/**
 * The pane showing an editor, or `NO_PANE`. The first, if the author opened two.
 *
 * Floating popups count. This is the question "is it on screen already", and the answer a popup
 * gives is yes — which is what stops a second popup being made for an editor already in one.
 */
export function paneShowing(panes: readonly Pane[], editor: string): number {
  return panes.findIndex((pane) => !pane.chrome && pane.editor === editor);
}

/**
 * The pane an `open` lands in: the active one, or — when the pointer is over chrome, or nowhere
 * at all — the biggest, which is the one the author is most likely looking at.
 *
 * This is "where the author is", and it answers a conversation pane like any other: closing the
 * pane the pointer is in, or splitting it, means *that* pane. Putting a different editor there is
 * {@link paneToShowIn}, which is the one that steps around a transcript.
 */
export function paneToUse(panes: readonly Pane[]): number {
  const usable = panes.filter(arrangeable);
  if (usable.length === 0) return NO_PANE;

  const active = panes.findIndex((pane) => arrangeable(pane) && pane.active);
  if (active !== NO_PANE) return active;

  const biggest = usable.reduce((a, b) => (area(b) > area(a) ? b : a));
  return panes.indexOf(biggest);
}

/**
 * The pane an automatic open *replaces*: {@link paneToUse}, unless that would cover a
 * conversation and something else is free. The author pointing at the transcript is not a request
 * to lose it — a click in the tree while reading what the agent said would otherwise open the
 * scene over the sentence being read.
 */
export function paneToShowIn(panes: readonly Pane[]): number {
  const usable = panes.filter(arrangeable);
  if (usable.length === 0) return NO_PANE;

  const room = sparing(usable);
  const active = panes.findIndex((pane) => arrangeable(pane) && pane.active && room.includes(pane));
  if (active !== NO_PANE) return active;

  const biggest = room.reduce((a, b) => (area(b) > area(a) ? b : a));
  return panes.indexOf(biggest);
}

/**
 * The pane an `open(where='elsewhere')` lands in: the biggest non-chrome pane that is not the one
 * asking. `NO_PANE` when there is no other — a window with one pane has nowhere else, and the
 * caller splits instead. Never chrome, so a two-pane window with a header still has an answer.
 */
export function paneElsewhere(panes: readonly Pane[], from: number): number {
  const others = panes.filter((pane, index) => arrangeable(pane) && index !== from);
  if (others.length === 0) return NO_PANE;
  const room = sparing(others);
  return panes.indexOf(room.reduce((a, b) => (area(b) > area(a) ? b : a)));
}

/**
 * The pane a `close` collapses. The last non-chrome pane is kept: a mesh of nothing but the
 * header is a window with no way back, and refusing is friendlier than emptying the screen.
 */
export function paneToClose(panes: readonly Pane[]): number {
  if (panes.filter(arrangeable).length < 2) return NO_PANE;
  return paneToUse(panes);
}

/**
 * Whether *this* pane may be collapsed — the same two rules `paneToClose` applies, asked of a pane
 * the author picked rather than of the mesh. A picker needs the verdict per pane, because it has to
 * say no while the pointer is still moving.
 */
export function paneClosable(panes: readonly Pane[], index: number): boolean {
  const pane = panes[index];
  if (!pane || !arrangeable(pane)) return false;
  return panes.filter(arrangeable).length >= 2;
}

/** The candidates worth covering: everything, minus the conversations, unless that is all of it. */
function sparing(candidates: readonly Pane[]): readonly Pane[] {
  const quiet = candidates.filter((pane) => pane.editor !== SPOKEN_IN);
  return quiet.length > 0 ? quiet : candidates;
}

const area = (pane: Pane): number => pane.width * pane.height;
