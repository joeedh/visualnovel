/**
 * Edge routing: a laid-out graph plus its edges becomes drawable paths, sampled polylines for
 * hit-testing, and the anchor point a label is typeset at.
 *
 * One path serves both purposes on purpose. If the drawn curve and the hit-tested geometry
 * came from different code, an edge could be clickable somewhere it isn't drawn — the exact
 * class of bug `@vn/debug2d` exists to chase down.
 */
import { round, type GraphEdge, type LaidOutNode, type Point } from './types.js';
import type { GraphLayout } from './layout.js';

export interface EdgeRoute {
  id: string;
  from: string;
  to: string;
  kind?: string;
  label?: string;
  /** SVG path data, fixed-precision so it can be pinned in a test. */
  path: string;
  /** Polyline approximation of `path`, for distance queries. */
  points: Point[];
  /** Where a label sits: the curve's midpoint. */
  labelAnchor: Point;
  /** True when the edge runs against the ranking (a loop back to an earlier scene). */
  back: boolean;
}

export interface RouteOptions {
  /** Samples per curve. More is smoother hit-testing and a longer points array. */
  samples?: number;
  /** How far a self-loop or back-edge bulges out to the side. */
  bulge?: number;
}

const DEFAULTS = { samples: 24, bulge: 56 };

interface Cubic {
  a: Point;
  c1: Point;
  c2: Point;
  b: Point;
}

const cubicAt = (c: Cubic, t: number): Point => {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: c.a.x * w0 + c.c1.x * w1 + c.c2.x * w2 + c.b.x * w3,
    y: c.a.y * w0 + c.c1.y * w1 + c.c2.y * w2 + c.b.y * w3,
  };
};

const pathOf = (c: Cubic): string =>
  `M ${round(c.a.x)} ${round(c.a.y)} C ${round(c.c1.x)} ${round(c.c1.y)} ` +
  `${round(c.c2.x)} ${round(c.c2.y)} ${round(c.b.x)} ${round(c.b.y)}`;

const bottom = (n: LaidOutNode): Point => ({ x: n.x + n.width / 2, y: n.y + n.height });
const top = (n: LaidOutNode): Point => ({ x: n.x + n.width / 2, y: n.y });
const right = (n: LaidOutNode): Point => ({ x: n.x + n.width, y: n.y + n.height / 2 });

/**
 * The curve for one edge. Three shapes, by geometry rather than by declared kind: a normal
 * descent leaves the bottom and enters the top; anything that does not descend leaves and
 * re-enters the right-hand side, bulging out far enough to stay clear of its own nodes; a
 * self-edge is that same side loop at its minimum.
 */
function curveFor(
  from: LaidOutNode,
  to: LaidOutNode,
  bulge: number,
): { cubic: Cubic; back: boolean } {
  if (from.id === to.id) {
    const a = right(from);
    const out = bulge;
    return {
      back: true,
      cubic: {
        a,
        c1: { x: a.x + out, y: a.y - from.height * 0.6 },
        c2: { x: a.x + out, y: a.y + from.height * 0.6 },
        b: { x: a.x, y: a.y + 1 },
      },
    };
  }

  const descends = to.y > from.y + from.height / 2;
  if (descends) {
    const a = bottom(from);
    const b = top(to);
    const lift = Math.max(24, (b.y - a.y) / 2);
    return {
      back: false,
      cubic: { a, c1: { x: a.x, y: a.y + lift }, c2: { x: b.x, y: b.y - lift }, b },
    };
  }

  const a = right(from);
  const b = right(to);
  const out = bulge + Math.abs(a.y - b.y) * 0.15;
  return {
    back: true,
    cubic: { a, c1: { x: a.x + out, y: a.y }, c2: { x: b.x + out, y: b.y }, b },
  };
}

/** Route every edge whose endpoints are both laid out. Order follows the input. */
export function routeEdges(
  layout: GraphLayout,
  edges: GraphEdge[],
  opts: RouteOptions = {},
): EdgeRoute[] {
  const { samples, bulge } = { ...DEFAULTS, ...opts };
  const routes: EdgeRoute[] = [];

  for (const edge of edges) {
    const from = layout.byId.get(edge.from);
    const to = layout.byId.get(edge.to);
    if (!from || !to) continue;

    const { cubic, back } = curveFor(from, to, bulge);
    const points: Point[] = [];
    for (let i = 0; i <= samples; i++) points.push(cubicAt(cubic, i / samples));

    routes.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.kind !== undefined ? { kind: edge.kind } : {}),
      ...(edge.label !== undefined ? { label: edge.label } : {}),
      path: pathOf(cubic),
      points,
      labelAnchor: cubicAt(cubic, 0.5),
      back,
    });
  }
  return routes;
}

/**
 * Where a drag from a node's edge handle should start: the bottom of the card, which is where
 * every forward edge leaves from. Exported so the editor's ghost edge and the routed edge
 * agree on their origin.
 */
export const handleAnchor = (node: LaidOutNode): Point => bottom(node);
