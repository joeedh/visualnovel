/**
 * Where a ring goes, given the box a node reports and what a click there actually lands on.
 *
 * A node's box is not its hit area. A gen-graph socket is an 8×8 dot carrying a `::before` of
 * `position: absolute; inset: -5px`, and the browser hit-tests a pseudo-element as part of the
 * element that originates it, so the socket answers for 18×18 while `getBoundingClientRect()`
 * reports 8×8. `getClientRects()` does not report pseudo-elements either, so nothing in the DOM
 * API closes that gap and the ring is drawn with {@link RING_PAD} of slack around whatever rect
 * it ends up with.
 */
import type { AnchorRect } from './anchors.js';

/**
 * How far outside its rect a ring is drawn. Covers a hit pad no rect reports, and keeps the ring
 * off the control it points at rather than over its edge.
 */
export const RING_PAD = 4;

export const centreOf = (rect: AnchorRect): { x: number; y: number } => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

/** Whether every side of `inner` lies within `outer`. */
export function contains(outer: AnchorRect, inner: AnchorRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  );
}

/** The smallest rect covering both. */
export function union(a: AnchorRect, b: AnchorRect): AnchorRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.right, b.right);
  const bottom = Math.max(a.bottom, b.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** The same rect with `pad` added on every side. */
export function outset(rect: AnchorRect, pad: number): AnchorRect {
  return {
    left  : rect.left - pad,
    top   : rect.top - pad,
    right : rect.right + pad,
    bottom: rect.bottom + pad,
    width : rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/**
 * The rect to ring. Widened to cover the hit wherever the hit reaches the anchor but reports a box
 * outside it — an overflowing canvas, an absolutely positioned child — because the hit is evidence
 * of a target the anchor's own box under-reports. A hit already inside the box adds nothing.
 */
export function ringRect(box: AnchorRect, hit?: AnchorRect): AnchorRect {
  return hit && !contains(box, hit) ? union(box, hit) : box;
}

/** How far the caption sits from the ring it explains, and how close it may come to an edge. */
export const CAPTION_GAP = 8;

export interface Size {
  width: number;
  height: number;
}

/** How far the author has dragged the caption from where it would otherwise sit. */
export interface Nudge {
  dx: number;
  dy: number;
}

/**
 * Where the caption goes: under the ring where the window has room for it, over the ring where it
 * does not, plus whatever the author has dragged it by. The result is clamped to the window, so a
 * drag cannot put the instruction out of reach, and a ring near an edge does not push it there.
 *
 * The clamped offset comes back as `nudge` for the caller to keep in place of the one it passed.
 * A drag that is holding the caption against an edge would otherwise accumulate distance the
 * window never granted, and dragging back would move nothing until that distance was retraced.
 */
export function captionAt(
  ring: AnchorRect,
  caption: Size,
  view: Size,
  nudge: Nudge = { dx: 0, dy: 0 },
): { left: number; top: number; nudge: Nudge } {
  const below = ring.bottom + CAPTION_GAP;
  const room = below + caption.height + CAPTION_GAP <= view.height;
  const top = room ? below : ring.top - CAPTION_GAP - caption.height;
  const at = {
    left: within(ring.left + nudge.dx, caption.width, view.width),
    top : within(top + nudge.dy, caption.height, view.height),
  };
  return { ...at, nudge: { dx: at.left - ring.left, dy: at.top - top } };
}

/** `at`, moved the least distance that puts a `size`-long box inside `view` with a gap at each end. */
function within(at: number, size: number, view: number): number {
  return Math.min(Math.max(at, CAPTION_GAP), Math.max(CAPTION_GAP, view - size - CAPTION_GAP));
}
