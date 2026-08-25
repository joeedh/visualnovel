import type { Graph, GraphId } from 'pathux-graph';

import { genNodeSpec } from './registry.js';

/** One output node that is still active, with the slot key written on it. */
export interface GenActiveOutput {
  id: GraphId;
  /** The slot this output fills. Empty where the author has not named one yet. */
  slot: string;
}

/**
 * The output nodes a run may target, each with the slot it binds. A type that names a slot but
 * carries no `active` prop is always active, which is the rule a slot is bound by everywhere
 * else. An output naming no slot is still returned, because it is a node a run can terminate on.
 */
export function activeOutputs(graph: Graph): GenActiveOutput[] {
  const out: GenActiveOutput[] = [];

  for (const node of graph.nodes) {
    const key = genNodeSpec(node.def.typeName)?.slotProp;
    if (key === undefined || node.props.active?.getValue() === false) {
      continue;
    }
    out.push({ id: node.id, slot: String(node.props[key]?.getValue() ?? '').trim() });
  }

  return out;
}
