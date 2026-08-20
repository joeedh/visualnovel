/**
 * Fragment hit geometry, shared by the engine and explainPick. The two modes test
 * different geometry: `using: 'pick'` tests the pick authority (pick.shape, expanded by
 * slop) and respects `pointer-events`, while `using: 'paint'` tests the drawn bounds.
 */
import { containsPoint, type Rect, type Vec2 } from '../geom.js';
import type { Fragment, Shape } from '../types.js';

export type Using = 'paint' | 'pick';

export function shapeBounds(shape: Shape, fallback: Rect): Rect {
  switch (shape.type) {
    case 'rect':
    case 'rrect':
      return shape.rect;
    case 'rects': {
      if (!shape.rects.length) return fallback;
      const xs = shape.rects.map((r) => r.x);
      const ys = shape.rects.map((r) => r.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return {
        x,
        y,
        w: Math.max(...shape.rects.map((r) => r.x + r.w)) - x,
        h: Math.max(...shape.rects.map((r) => r.y + r.h)) - y,
      };
    }
    case 'poly': {
      if (!shape.points.length) return fallback;
      const xs = shape.points.map((p) => p.x);
      const ys = shape.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'path':
      // Path data is opaque to the query core, so the drawn bounds are used instead
      return fallback;
  }
}

/** The rect `using: 'pick'` tests: pick.shape when present, expanded by slop. */
export function pickBounds(f: Fragment): Rect {
  const base = f.pick.shape ? shapeBounds(f.pick.shape, f.bounds) : f.bounds;
  const slop = f.pick.slop ?? 0;
  return slop
    ? { x: base.x - slop, y: base.y - slop, w: base.w + 2 * slop, h: base.h + 2 * slop }
    : base;
}

/** True when `p` (in the fragment's own space) is inside every ancestor clip. */
export function insideClips(f: Fragment, p: Vec2): boolean {
  return (f.clip ?? []).every((c) => containsPoint(c.rect, p));
}

/**
 * Point test for `at()`: pick geometry means "what a click would do", so pick-transparent
 * or clipped-away fragments miss; paint geometry means "what is drawn here".
 */
export function hitsPoint(f: Fragment, p: Vec2, using: Using): boolean {
  if (using === 'pick') {
    if (f.pick.mode === 'none') return false;
    return containsPoint(pickBounds(f), p) && insideClips(f, p);
  }
  return containsPoint(f.bounds, p) && insideClips(f, p);
}
