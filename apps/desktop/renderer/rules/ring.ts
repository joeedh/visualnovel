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
