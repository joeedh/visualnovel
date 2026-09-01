/**
 * Local geometry primitives. Deliberately duplicates a sliver of `@vn/util`: this package
 * sits outside the layering graph (`debug2d: []` in eslint.config.mjs) so it can be lifted
 * out of the repo or stripped from a build without dragging anything along. Do not
 * "deduplicate" this into a shared package.
 */

export type Vec2 = { x: number; y: number };

export type Rect = { x: number; y: number; w: number; h: number };

/** Affine 2D matrix, canvas convention: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat3 = { a: number; b: number; c: number; d: number; e: number; f: number };

export const IDENTITY: Mat3 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Compose: apply `n` first, then `m` (standard matrix product m·n). */
export function mul(m: Mat3, n: Mat3): Mat3 {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** Inverse, or `null` when the matrix is singular. */
export function invert(m: Mat3): Mat3 | null {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return null;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

export function scaleMat(sx: number, sy: number = sx): Mat3 {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function translateMat(tx: number, ty: number): Mat3 {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function applyToPoint(m: Mat3, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Axis-aligned bounding box of the transformed corners. */
export function applyToRect(m: Mat3, r: Rect): Rect {
  const corners = [
    applyToPoint(m, { x: r.x, y: r.y }),
    applyToPoint(m, { x: r.x + r.w, y: r.y }),
    applyToPoint(m, { x: r.x, y: r.y + r.h }),
    applyToPoint(m, { x: r.x + r.w, y: r.y + r.h }),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Point-in-rect with every edge inclusive, for range queries where a fragment grazing the
 * boundary should still count. {@link boxHitsPoint} is the one that answers where a click lands.
 */
export function containsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Whether a click at `p` would land on `r`, excluding the far edges the way a CSS box is
 * half-open. Two boxes sharing a border therefore tile rather than both claiming it, and a rect
 * with no area catches nothing.
 */
export function boxHitsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Intersection rect, or `null` when disjoint (zero-area overlap counts as disjoint). */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
