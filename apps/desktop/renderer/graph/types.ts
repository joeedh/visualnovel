/**
 * The neutral graph vocabulary the layout, routing and hit-testing modules share. It is
 * deliberately not the story vocabulary: the task DAG view reuses these same primitives, so
 * nothing here may know about scenes, choices or tasks. Callers project their domain into
 * `GraphNode`/`GraphEdge` and read the layout back by id.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** A node to be laid out. Width and height come from the caller; layout only places. */
export interface GraphNode {
  id: string;
  width: number;
  height: number;
}

/**
 * A directed edge. `kind` is opaque to layout and routing; it exists so the caller can style
 * (a `next` fallthrough vs. a `choice` decision) and so hit results can say which was hit.
 */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind?: string;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A node with its computed position. `x`/`y` are the top-left corner, in world units. */
export interface LaidOutNode extends GraphNode, Rect {
  /** Distance from a root, in layers. Ranks run top-to-bottom. */
  rank: number;
  /** Position within the rank, left to right. Stable for a given graph. */
  order: number;
}

export const rectOf = (n: LaidOutNode): Rect => ({
  x: n.x,
  y: n.y,
  width: n.width,
  height: n.height,
});

export const centerOf = (r: Rect): Point => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

/** The tight bounding box of some rects, or a zero rect at the origin when there are none. */
export function boundsOf(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Fixed-precision rounding, so an SVG path string is stable enough to pin in a test. */
export const round = (n: number): number => Math.round(n * 100) / 100;
