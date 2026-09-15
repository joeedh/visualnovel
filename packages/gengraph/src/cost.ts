import type { Graph, GraphId, Node } from 'pathux-graph';

import { flattenNodes, linkedSources, nodeKey } from './nodekey.js';
import { genNodeSpec } from './registry.js';
import type { GenCostLine } from './registry.js';

/** What a whole graph is expected to spend if it runs from nothing. */
export interface GenGraphEstimate {
  /** Every expected call, merged by service, model and unit. */
  lines: GenCostLine[];
  /** What each node contributes by node key, with any refine multiplier already applied. */
  byNode: Map<GraphId, GenCostLine[]>;
  /** The nodes a refine pass may re-run, which is the entry point and its downstream. */
  refineTail: GraphId[];
}

export interface GenEstimateOptions {
  /**
   * How many times the refine tail may run, from `config.max_refine_attempts`. One
   * attempt, the default, applies no multiplier at all.
   */
  maxRefineAttempts?: number;
  /**
   * The project's image model, from `config.models.image`, which an image node with an empty
   * model prop is priced against. Left out, such a node prices as an unknown model.
   */
  imageModel?: string;
}

/**
 * Sums what every node expects to spend, the nodes inside each group instance included. All
 * of a graph's edges are known before it runs, so this is a complete figure rather than the
 * first wave's share of one.
 *
 * The tail downstream of the refine entry point is counted `maxRefineAttempts` times,
 * because a critique sends the prompt back through it, so the total is the worst case
 * rather than one attempt. A run that passes first time spends less.
 */
export function estimateGraph(graph: Graph, opts: GenEstimateOptions = {}): GenGraphEstimate {
  const attempts = Math.max(1, Math.floor(opts.maxRefineAttempts ?? 1));
  const entry = attempts > 1 ? refineEntry(graph) : undefined;
  const tail = entry === undefined ? new Set<GraphId>() : downstreamOf(graph, entry);
  const members = new Set(flattenNodes(graph));

  const byNode = new Map<GraphId, GenCostLine[]>();
  const all: GenCostLine[] = [];

  for (const node of graph.sort().order) {
    const estimate = genNodeSpec(node.def.typeName)?.estimate;
    if (estimate === undefined) {
      continue;
    }

    const connected = new Set<string>();
    for (const [key, sock] of Object.entries(node.inputs)) {
      if (linkedSources(sock, members).length > 0) {
        connected.add(key);
      }
    }

    const props: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(node.props)) {
      props[key] = prop.getValue();
    }

    const key = nodeKey(node);
    const factor = tail.has(key) ? attempts : 1;
    const ctx = {
      connected,
      ...(opts.imageModel === undefined ? {} : { imageModel: opts.imageModel }),
    };
    const lines = estimate(props, ctx).map((line) => ({
      ...line,
      count: line.count * factor,
    }));

    if (lines.length > 0) {
      byNode.set(key, lines);
      all.push(...lines);
    }
  }

  return { lines: mergeCostLines(all), byNode, refineTail: [...tail] };
}

/**
 * Finds the node a refine pass sends the prompt back to. A node declaring `refineInput`
 * is the entry point once that input is wired. With none wired, the entry point is the
 * node declaring `refineFallback`, which is the derived prompt, so a longer chain re-runs.
 */
export function refineEntry(graph: Graph): Node | undefined {
  const nodes = flattenNodes(graph);
  const members = new Set(nodes);
  let fallback: Node | undefined;

  for (const node of nodes) {
    const spec = genNodeSpec(node.def.typeName);
    if (spec === undefined) {
      continue;
    }

    if (spec.refineInput !== undefined) {
      const sock = node.inputs[spec.refineInput];
      if (sock !== undefined && linkedSources(sock, members).length > 0) {
        return node;
      }
    }
    if (spec.refineFallback === true && fallback === undefined) {
      fallback = node;
    }
  }

  return fallback;
}

/** The keys of a node and everything reachable from its outputs, group boundaries crossed. */
export function downstreamOf(graph: Graph, from: Node): Set<GraphId> {
  const members = new Set(flattenNodes(graph));
  const seen = new Set<Node>([from]);
  const stack: Node[] = [from];

  while (stack.length > 0) {
    const node = stack.pop()!;

    for (const sock of Object.values(node.outputs)) {
      for (const target of sock.resolvedEdges()) {
        const next = target.owningNode as Node | undefined;

        if (next !== undefined && members.has(next) && !seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  }

  return new Set([...seen].map(nodeKey));
}

/** Adds up the lines that name the same service, model and unit. */
export function mergeCostLines(lines: readonly GenCostLine[]): GenCostLine[] {
  const merged = new Map<string, GenCostLine>();

  for (const line of lines) {
    const key = `${line.service} ${line.model} ${line.unit}`;
    const found = merged.get(key);

    if (found === undefined) {
      merged.set(key, { ...line });
    } else {
      found.count += line.count;
    }
  }

  return [...merged.values()];
}
