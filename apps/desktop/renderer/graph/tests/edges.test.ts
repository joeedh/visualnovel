import { handleAnchor, routeEdges } from '../edges.js';
import { layoutGraph } from '../layout.js';
import type { Graph, GraphEdge } from '../types.js';

const node = (id: string) => ({ id, width: 160, height: 90 });
const edge = (from: string, to: string, rest: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  ...rest,
});

const CHAIN: Graph = {
  nodes: ['a', 'b'].map(node),
  edges: [edge('a', 'b', { kind: 'choice', label: 'Tell the truth' })],
};

describe('routeEdges', () => {
  it('leaves the bottom of the source and enters the top of the target', () => {
    const layout = layoutGraph(CHAIN);
    const [route] = routeEdges(layout, CHAIN.edges);
    const a = layout.byId.get('a');
    const b = layout.byId.get('b');
    expect(route?.points[0]).toEqual({ x: a && a.x + 80, y: a && a.y + 90 });
    expect(route?.points.at(-1)).toEqual({ x: b && b.x + 80, y: b?.y });
  });

  it('carries kind and label through, and anchors the label on the curve', () => {
    const layout = layoutGraph(CHAIN);
    const [route] = routeEdges(layout, CHAIN.edges);
    expect(route?.kind).toBe('choice');
    expect(route?.label).toBe('Tell the truth');
    expect(route?.back).toBe(false);
    // Midway between the two cards, horizontally centred.
    expect(route?.labelAnchor.x).toBeCloseTo(0, 6);
    expect(route?.labelAnchor.y).toBeCloseTo(134, 6);
  });

  it('omits kind and label entirely when the edge has none', () => {
    const g: Graph = { nodes: ['a', 'b'].map(node), edges: [edge('a', 'b')] };
    const [route] = routeEdges(layoutGraph(g), g.edges);
    expect(route && 'kind' in route).toBe(false);
    expect(route && 'label' in route).toBe(false);
  });

  it('emits a fixed-precision path, so a golden test can pin it', () => {
    const layout = layoutGraph(CHAIN);
    const [route] = routeEdges(layout, CHAIN.edges);
    expect(route?.path).toBe('M 0 90 C 0 134 0 134 0 178');
  });

  it('routes a back edge out to the side, flagged as back', () => {
    const g: Graph = {
      nodes: ['hub', 'a'].map(node),
      edges: [edge('hub', 'a'), edge('a', 'hub')],
    };
    const layout = layoutGraph(g);
    const routes = routeEdges(layout, g.edges);
    const back = routes.find((r) => r.id === 'a->hub');
    expect(back?.back).toBe(true);
    // The back edge bulges right of both cards rather than cutting through them
    const rightmost = Math.max(...layout.nodes.map((n) => n.x + n.width));
    expect(Math.max(...(back?.points ?? []).map((p) => p.x))).toBeGreaterThan(rightmost);
  });

  it('draws a self-edge as a side loop that returns to its own card', () => {
    const g: Graph = { nodes: [node('loop')], edges: [edge('loop', 'loop')] };
    const [route] = routeEdges(layoutGraph(g), g.edges);
    expect(route?.back).toBe(true);
    const first = route?.points[0];
    const last = route?.points.at(-1);
    expect(Math.abs((first?.y ?? 0) - (last?.y ?? 0))).toBeLessThan(2);
    expect(route?.points.length).toBeGreaterThan(2);
  });

  it('samples the curve densely enough for hit-testing', () => {
    const [route] = routeEdges(layoutGraph(CHAIN), CHAIN.edges, { samples: 8 });
    expect(route?.points).toHaveLength(9);
  });

  it('skips an edge whose endpoints were not laid out', () => {
    const layout = layoutGraph({ nodes: [node('a')], edges: [] });
    expect(routeEdges(layout, [edge('a', 'ghost')])).toEqual([]);
  });

  it('anchors a drag handle where the wire actually leaves the card', () => {
    const layout = layoutGraph(CHAIN);
    const a = layout.byId.get('a');
    const [route] = routeEdges(layout, CHAIN.edges);
    expect(a && handleAnchor(a)).toEqual(route?.points[0]);
  });
});
