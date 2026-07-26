import { routeEdges } from '../edges.js';
import { distanceToEdge, edgeAt, nodeAt, pick } from '../hit.js';
import { layoutGraph } from '../layout.js';
import { IDENTITY, toScreen } from '../viewport.js';
import type { Graph, GraphEdge } from '../types.js';

const node = (id: string) => ({ id, width: 160, height: 90 });
const edge = (from: string, to: string): GraphEdge => ({ id: `${from}->${to}`, from, to });

const GRAPH: Graph = { nodes: ['a', 'b'].map(node), edges: [edge('a', 'b')] };
const layout = layoutGraph(GRAPH);
const routes = routeEdges(layout, GRAPH.edges);
const a = layout.byId.get('a');

describe('nodeAt', () => {
  it('finds the node containing a world point, and nothing outside it', () => {
    expect(nodeAt(layout, { x: 0, y: 45 })?.id).toBe('a');
    expect(nodeAt(layout, { x: 0, y: 140 })).toBeUndefined();
  });

  it('accepts a point on the boundary', () => {
    expect(nodeAt(layout, { x: -80, y: 0 })?.id).toBe('a');
  });
});

describe('distanceToEdge', () => {
  it('is zero on the curve and grows with lateral offset', () => {
    const on = routes[0]?.points[3];
    expect(on && distanceToEdge(on, routes[0]!)).toBeCloseTo(0, 6);
    expect(distanceToEdge({ x: 20, y: 134 }, routes[0]!)).toBeCloseTo(20, 1);
  });

  it('clamps to the segment ends rather than the infinite line', () => {
    // Far above the start of the curve: distance is to the endpoint, not to the extension.
    expect(distanceToEdge({ x: 0, y: -100 }, routes[0]!)).toBeCloseTo(190, 1);
  });
});

describe('edgeAt', () => {
  it('returns the nearest edge inside the slop and none outside it', () => {
    expect(edgeAt(routes, { x: 6, y: 134 }, 8)?.edge.id).toBe('a->b');
    expect(edgeAt(routes, { x: 40, y: 134 }, 8)).toBeUndefined();
  });
});

describe('pick', () => {
  it('resolves a screen point through the viewport', () => {
    const vp = { x: 250, y: 30, scale: 1 };
    const screen = toScreen(vp, { x: 0, y: 45 });
    expect(pick(layout, routes, screen, vp)).toEqual({ type: 'node', node: a });
  });

  it('prefers a node to an edge passing behind it', () => {
    const overlapping = routeEdges(layout, [edge('a', 'b'), { id: 'x', from: 'a', to: 'a' }]);
    const hit = pick(layout, overlapping, toScreen(IDENTITY, { x: 0, y: 45 }), IDENTITY);
    expect(hit.type).toBe('node');
  });

  it('reports background when nothing is close', () => {
    expect(pick(layout, routes, { x: 900, y: 900 }, IDENTITY)).toEqual({ type: 'background' });
  });

  /**
   * The contract this module exists for. 8px of screen slop is 16 world units at half zoom and
   * 4 at double — a wire stays equally easy to hit at any zoom. If slop were applied in world
   * units instead, both of these would resolve the same way and one of them would be wrong.
   */
  it('scales hit slop in screen space, not world space', () => {
    const world = { x: 12, y: 134 };
    const zoomedOut = { x: 0, y: 0, scale: 0.5 };
    const zoomedIn = { x: 0, y: 0, scale: 2 };
    expect(pick(layout, routes, toScreen(zoomedOut, world), zoomedOut).type).toBe('edge');
    expect(pick(layout, routes, toScreen(zoomedIn, world), zoomedIn).type).toBe('background');
  });

  it('honours node slop, also in screen pixels', () => {
    // Just off a's bottom-right corner, and well clear of the wire running down from x = 0.
    const justOutside = toScreen(IDENTITY, { x: 88, y: 96 });
    expect(pick(layout, routes, justOutside, IDENTITY, { nodeSlop: 0, edgeSlop: 0 }).type).toBe(
      'background',
    );
    expect(pick(layout, routes, justOutside, IDENTITY, { nodeSlop: 10 }).type).toBe('node');
  });

  it('returns the distance with an edge hit, so a caller can rank near-misses', () => {
    const hit = pick(layout, routes, toScreen(IDENTITY, { x: 5, y: 134 }), IDENTITY);
    expect(hit.type === 'edge' && hit.distance).toBeCloseTo(5, 1);
  });

  it('never picks anything from an empty graph', () => {
    const empty = layoutGraph({ nodes: [], edges: [] });
    expect(pick(empty, [], { x: 0, y: 0 }, IDENTITY)).toEqual({ type: 'background' });
  });
});
