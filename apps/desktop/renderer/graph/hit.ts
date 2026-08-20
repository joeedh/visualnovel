/**
 * Hit-testing a laid-out graph.
 *
 * Slop is authored in screen pixels while the geometry is in world units, so every tolerance is
 * divided through by the viewport scale before it meets a coordinate. `pick` takes a screen
 * point and a viewport and performs that conversion itself, so a caller cannot invert it.
 */
import { screenToWorldDistance, toWorld, type Viewport } from './viewport.js';
import type { LaidOutNode, Point, Rect } from './types.js';
import type { EdgeRoute } from './edges.js';
import type { GraphLayout } from './layout.js';

export interface PickOptions {
  /** Screen-pixel tolerance around a node's box. */
  nodeSlop?: number;
  /** Screen-pixel tolerance around an edge's curve. */
  edgeSlop?: number;
}

const DEFAULTS = { nodeSlop: 0, edgeSlop: 8 };

export type Pick =
  | { type: 'node'; node: LaidOutNode }
  | { type: 'edge'; edge: EdgeRoute; distance: number }
  | { type: 'background' };

const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + by * 2,
  height: r.height + by * 2,
});

const contains = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Distance from a point to a segment, or to the segment's single point when degenerate. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from a world point to an edge's sampled polyline. */
export function distanceToEdge(p: Point, edge: EdgeRoute): number {
  let best = Infinity;
  for (let i = 1; i < edge.points.length; i++) {
    best = Math.min(
      best,
      distanceToSegment(p, edge.points[i - 1] as Point, edge.points[i] as Point),
    );
  }
  return best;
}

/**
 * The node under a world point. Later nodes win, matching paint order — the last one drawn is
 * the one visibly on top.
 */
export function nodeAt(layout: GraphLayout, world: Point, slop = 0): LaidOutNode | undefined {
  for (let i = layout.nodes.length - 1; i >= 0; i--) {
    const node = layout.nodes[i] as LaidOutNode;
    if (contains(inflate(node, slop), world)) return node;
  }
  return undefined;
}

/** The nearest edge within `slop` world units of a world point, or undefined. */
export function edgeAt(
  edges: EdgeRoute[],
  world: Point,
  slop: number,
): { edge: EdgeRoute; distance: number } | undefined {
  let best: { edge: EdgeRoute; distance: number } | undefined;
  for (const edge of edges) {
    const distance = distanceToEdge(world, edge);
    if (distance <= slop && (!best || distance < best.distance)) best = { edge, distance };
  }
  return best;
}

/**
 * What is under a screen point. Nodes beat edges: an edge that passes behind a card is not
 * what the user is pointing at, and the card is the larger, more obvious target.
 */
export function pick(
  layout: GraphLayout,
  edges: EdgeRoute[],
  screen: Point,
  viewport: Viewport,
  opts: PickOptions = {},
): Pick {
  const { nodeSlop, edgeSlop } = { ...DEFAULTS, ...opts };
  const world = toWorld(viewport, screen);

  const node = nodeAt(layout, world, screenToWorldDistance(viewport, nodeSlop));
  if (node) return { type: 'node', node };

  const edge = edgeAt(edges, world, screenToWorldDistance(viewport, edgeSlop));
  if (edge) return { type: 'edge', edge: edge.edge, distance: edge.distance };

  return { type: 'background' };
}
