import { layoutGraph } from '../layout.js';
import type { Graph, GraphEdge } from '../types.js';

const node = (id: string) => ({ id, width: 160, height: 90 });
const edge = (from: string, to: string, kind = 'choice'): GraphEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  kind,
});

/** arrival forks to greet and rooftop; both converge on dinner. */
const DIAMOND: Graph = {
  nodes: ['arrival', 'greet', 'rooftop', 'dinner'].map(node),
  edges: [
    edge('arrival', 'greet'),
    edge('arrival', 'rooftop'),
    edge('greet', 'dinner'),
    edge('rooftop', 'dinner'),
  ],
};

const rankOf = (g: Graph, id: string): number | undefined => layoutGraph(g).byId.get(id)?.rank;

describe('layoutGraph', () => {
  it('ranks by longest path, so a converging node sits below both branches', () => {
    expect(rankOf(DIAMOND, 'arrival')).toBe(0);
    expect(rankOf(DIAMOND, 'greet')).toBe(1);
    expect(rankOf(DIAMOND, 'rooftop')).toBe(1);
    expect(rankOf(DIAMOND, 'dinner')).toBe(2);
  });

  it('puts a node below its deepest parent, not its shallowest', () => {
    const g: Graph = {
      nodes: ['a', 'b', 'c', 'd'].map(node),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'd')],
    };
    expect(rankOf(g, 'd')).toBe(3);
  });

  it('is deterministic — the same graph lays out identically every time', () => {
    const once = JSON.stringify(layoutGraph(DIAMOND).nodes);
    for (let i = 0; i < 5; i++) expect(JSON.stringify(layoutGraph(DIAMOND).nodes)).toBe(once);
  });

  it('lays out a cycle instead of hanging, and marks the back edge', () => {
    const g: Graph = {
      nodes: ['hub', 'a', 'b'].map(node),
      edges: [edge('hub', 'a'), edge('a', 'b'), edge('b', 'hub')],
    };
    const layout = layoutGraph(g);
    expect(layout.nodes).toHaveLength(3);
    expect([...layout.backEdges]).toEqual(['b->hub']);
    expect(layout.byId.get('hub')?.rank).toBe(0);
    expect(layout.byId.get('b')?.rank).toBe(2);
  });

  it('handles a graph that is nothing but a cycle, with no root to start from', () => {
    const g: Graph = {
      nodes: ['a', 'b'].map(node),
      edges: [edge('a', 'b'), edge('b', 'a')],
    };
    const layout = layoutGraph(g);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(layout.backEdges.size).toBe(1);
  });

  it('treats a self-edge as a back edge rather than an infinite rank', () => {
    const g: Graph = { nodes: [node('loop')], edges: [edge('loop', 'loop')] };
    const layout = layoutGraph(g);
    expect(layout.byId.get('loop')?.rank).toBe(0);
    expect([...layout.backEdges]).toEqual(['loop->loop']);
  });

  it('places unreachable scenes rather than dropping them', () => {
    const g: Graph = {
      nodes: ['arrival', 'orphan'].map(node),
      edges: [],
    };
    expect(layoutGraph(g).nodes).toHaveLength(2);
  });

  it('ignores edges pointing at a scene that does not exist', () => {
    const g: Graph = { nodes: [node('a')], edges: [edge('a', 'ghost')] };
    const layout = layoutGraph(g);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.bounds.width).toBe(160);
  });

  it('centres each rank on x = 0, so ranks of different widths stay aligned', () => {
    const layout = layoutGraph(DIAMOND);
    const arrival = layout.byId.get('arrival');
    expect(arrival && arrival.x + arrival.width / 2).toBeCloseTo(0, 6);
    const rank1 = layout.ranks[1]?.map((id) => layout.byId.get(id));
    const spread = rank1?.map((n) => (n ? n.x + n.width / 2 : NaN)) ?? [];
    expect(spread[0]).toBeCloseTo(-100, 6);
    expect(spread[1]).toBeCloseTo(100, 6);
  });

  it('separates ranks by the rank gap', () => {
    const layout = layoutGraph(DIAMOND, { rankGap: 50 });
    expect((layout.byId.get('greet')?.y ?? 0) - (layout.byId.get('arrival')?.y ?? 0)).toBe(140);
  });

  it('reduces crossings by ordering a rank against its parents', () => {
    // Authored so the naive order (b1, b2) crosses: a1 points at b2 and a2 at b1.
    const g: Graph = {
      nodes: ['root', 'a1', 'a2', 'b1', 'b2'].map(node),
      edges: [edge('root', 'a1'), edge('root', 'a2'), edge('a1', 'b2'), edge('a2', 'b1')],
    };
    const layout = layoutGraph(g);
    const x = (id: string): number => layout.byId.get(id)?.x ?? 0;
    expect(x('a1') < x('a2')).toBe(true);
    expect(x('b2') < x('b1')).toBe(true);
  });

  it('lays out a large synthetic graph without stack overflow', () => {
    // A deep chain is the case a recursive DFS would blow up on.
    const ids = Array.from({ length: 400 }, (_, i) => `s${i}`);
    const g: Graph = {
      nodes: ids.map(node),
      edges: ids.slice(1).map((id, i) => edge(`s${i}`, id, 'next')),
    };
    const layout = layoutGraph(g);
    expect(layout.ranks).toHaveLength(400);
    expect(layout.backEdges.size).toBe(0);
  });

  it('returns an empty layout for an empty graph', () => {
    const layout = layoutGraph({ nodes: [], edges: [] });
    expect(layout.nodes).toEqual([]);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('tidy', () => {
  const centre = (layout: ReturnType<typeof layoutGraph>, id: string): number => {
    const n = layout.byId.get(id);
    return n ? n.x + n.width / 2 : NaN;
  };

  // The defect the pass exists for: each rank is centred on its own width, so a lone child of a
  // left-hand parent is drawn under the middle of the rank above and its edge leans across it.
  it('puts a single child under its parent instead of under the rank', () => {
    const g: Graph = {
      nodes: ['a', 'b', 'c', 'kid'].map(node),
      edges: [edge('a', 'kid')],
    };
    const plain = layoutGraph(g);
    const tidy = layoutGraph(g, { tidy: true });
    expect(Math.abs(centre(plain, 'kid') - centre(plain, 'a'))).toBeGreaterThan(1);
    expect(Math.abs(centre(tidy, 'kid') - centre(tidy, 'a'))).toBeLessThan(1);
  });

  it('keeps the ordering the crossing-reduction chose', () => {
    const tidy = layoutGraph(DIAMOND, { tidy: true });
    expect(tidy.ranks).toEqual(layoutGraph(DIAMOND).ranks);
  });

  it('never overlaps two nodes in a rank, however hard they pull together', () => {
    // Every node in the middle rank wants the same place: directly under the one root.
    const kids = ['k0', 'k1', 'k2', 'k3', 'k4'];
    const g: Graph = {
      nodes: ['root', ...kids].map(node),
      edges: kids.map((k) => edge('root', k)),
    };
    const tidy = layoutGraph(g, { tidy: true });
    const row = kids.map((k) => tidy.byId.get(k)).filter((n) => n !== undefined);
    row.sort((a, b) => a.x - b.x);
    for (const [i, n] of row.entries()) {
      if (i === 0) continue;
      const left = row[i - 1] as (typeof row)[number];
      expect(n.x).toBeGreaterThanOrEqual(left.x + left.width - 0.001);
    }
  });

  // Same graph in, same coordinates out — the module's whole contract, and a straightening pass
  // is exactly the kind of iteration that quietly breaks it.
  it('is deterministic', () => {
    const once = layoutGraph(DIAMOND, { tidy: true }).nodes;
    const twice = layoutGraph(DIAMOND, { tidy: true }).nodes;
    expect(twice).toEqual(once);
  });

  it('leaves the picture centred on x = 0', () => {
    const tidy = layoutGraph(DIAMOND, { tidy: true });
    expect(tidy.bounds.x + tidy.bounds.width / 2).toBeCloseTo(0, 6);
  });
});
