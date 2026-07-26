/**
 * Deterministic layered layout for a directed graph. Same graph in, same coordinates out —
 * there is no force-directed relaxation and no randomness anywhere, because the view
 * re-lays-out on every model reload and a graph that reshuffles itself reads as broken.
 *
 * Ranks run top-to-bottom, matching the `flowchart TD` that `toMermaid` emits, so the app and
 * the `.mmd` export describe the same shape.
 */
import { boundsOf, type Graph, type GraphEdge, type LaidOutNode, type Rect } from './types.js';

export interface LayoutOptions {
  /** Horizontal gap between two nodes in the same rank. */
  nodeGap?: number;
  /** Vertical gap between one rank and the next. */
  rankGap?: number;
  /** Crossing-reduction sweeps. Each is one pass down and one back up. */
  sweeps?: number;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  byId: Map<string, LaidOutNode>;
  /** Node ids per rank, top rank first — the order they were placed in. */
  ranks: string[][];
  /** Edges that point backwards against the ranking; routing draws them differently. */
  backEdges: Set<string>;
  bounds: Rect;
}

const DEFAULTS = { nodeGap: 40, rankGap: 88, sweeps: 4 };

/**
 * Classify edges as forward or back, by DFS from the graph's roots in input order. Cycles are
 * legal in a VN — looping to a hub scene is normal structure — so they are broken for ranking
 * purposes only, never rejected. Iterative rather than recursive: a synthetic 60-scene chain
 * is a realistic test case and the recursion depth would be its length.
 */
function classifyEdges(nodeIds: string[], edges: GraphEdge[]): Set<string> {
  const out = new Map<string, GraphEdge[]>(nodeIds.map((id) => [id, []]));
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const e of edges) {
    out.get(e.from)?.push(e);
    if (out.has(e.from) && indegree.has(e.to)) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const back = new Set<string>();
  const state = new Map<string, 'open' | 'done'>();
  // Roots first, then anything left over — a pure cycle has no root and still needs visiting.
  const starts = [...nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0), ...nodeIds];

  for (const start of starts) {
    if (state.has(start)) continue;
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    state.set(start, 'open');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const outgoing = out.get(frame.id) ?? [];
      if (frame.next >= outgoing.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const edge = outgoing[frame.next++] as GraphEdge;
      const target = state.get(edge.to);
      if (target === 'open') back.add(edge.id);
      else if (target === undefined) {
        state.set(edge.to, 'open');
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }
  return back;
}

/** Longest-path ranking over the forward edges: a node sits one below its deepest parent. */
function rankNodes(nodeIds: string[], forward: GraphEdge[]): Map<string, number> {
  const out = new Map<string, GraphEdge[]>(nodeIds.map((id) => [id, []]));
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const e of forward) {
    out.get(e.from)?.push(e);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    for (const e of out.get(id) ?? []) {
      rank.set(e.to, Math.max(rank.get(e.to) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }
  return rank;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Barycentre crossing reduction. Each node moves to the average position of its neighbours in
 * the adjacent rank; a node with no neighbours there keeps its current slot. Sorting is by
 * (barycentre, current index), so the sort is total and the result can't depend on the
 * engine's sort stability.
 */
function orderRanks(ranks: string[][], forward: GraphEdge[], sweeps: number): string[][] {
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of forward) {
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
    succs.set(e.from, [...(succs.get(e.from) ?? []), e.to]);
  }

  const current = ranks.map((r) => [...r]);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const down = sweep % 2 === 0;
    const order = new Map<string, number>();
    current.forEach((rank) => rank.forEach((id, i) => order.set(id, i)));

    const indices = down
      ? current.map((_, i) => i).slice(1)
      : current
          .map((_, i) => i)
          .slice(0, -1)
          .reverse();

    for (const i of indices) {
      const rank = current[i] as string[];
      const neighboursOf = (id: string): string[] =>
        (down ? preds.get(id) : succs.get(id))?.filter((n) => order.has(n)) ?? [];
      const keyed = rank.map((id, slot) => {
        const ns = neighboursOf(id);
        return {
          id,
          slot,
          bary: ns.length > 0 ? mean(ns.map((n) => order.get(n) as number)) : slot,
        };
      });
      keyed.sort((a, b) => a.bary - b.bary || a.slot - b.slot);
      const reordered = keyed.map((k) => k.id);
      current[i] = reordered;
      reordered.forEach((id, slot) => order.set(id, slot));
    }
  }
  return current;
}

/**
 * Lay a graph out. Edges whose endpoints are not both present are ignored rather than being an
 * error — a `goto` to a scene that does not exist is a story diagnostic, not a layout one, and
 * the editor still has to draw the scenes that do exist.
 */
export function layoutGraph(graph: Graph, opts: LayoutOptions = {}): GraphLayout {
  const { nodeGap, rankGap, sweeps } = { ...DEFAULTS, ...opts };
  const nodeIds = graph.nodes.map((n) => n.id);
  const present = new Set(nodeIds);
  const edges = graph.edges.filter((e) => present.has(e.from) && present.has(e.to));

  const backEdges = classifyEdges(nodeIds, edges);
  const forward = edges.filter((e) => !backEdges.has(e.id) && e.from !== e.to);
  const rank = rankNodes(nodeIds, forward);

  const depth = Math.max(0, ...nodeIds.map((id) => rank.get(id) ?? 0));
  const initial: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const id of nodeIds) (initial[rank.get(id) ?? 0] as string[]).push(id);
  const ranks = orderRanks(initial, forward, sweeps);

  const sizeOf = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: LaidOutNode[] = [];
  let y = 0;
  for (const [r, ids] of ranks.entries()) {
    const sizes = ids.map((id) => sizeOf.get(id));
    const rowWidth =
      sizes.reduce((sum, n) => sum + (n?.width ?? 0), 0) + nodeGap * Math.max(0, ids.length - 1);
    const rowHeight = Math.max(0, ...sizes.map((n) => n?.height ?? 0));

    // Ranks are centred on x = 0, so adding a node to one rank doesn't shift the others.
    let x = -rowWidth / 2;
    for (const [order, id] of ids.entries()) {
      const node = sizeOf.get(id);
      if (!node) continue;
      nodes.push({ ...node, x, y: y + (rowHeight - node.height) / 2, rank: r, order });
      x += node.width + nodeGap;
    }
    y += rowHeight + rankGap;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { nodes, byId, ranks, backEdges, bounds: boundsOf(nodes) };
}
