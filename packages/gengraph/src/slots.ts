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

/** One slot's graph and the output node inside it that names the slot. */
export interface GenSlotBinding<T> {
  entry: T;
  target: GraphId;
}

/** The slot→graph index, and the slots left out of it. */
export interface GenSlotBindings<T> {
  bound: Map<string, GenSlotBinding<T>>;
  /** Slots more than one active output claims, which stay bound to no graph. */
  conflicts: string[];
}

/**
 * Indexes graphs by the slot each active output binds to. A slot two active outputs claim is left
 * unbound and reported, because which graph drew the picture would otherwise depend on the order
 * the caller happened to load them in. An output naming no slot binds nothing.
 */
export function bindSlots<T extends { graph: Graph }>(entries: Iterable<T>): GenSlotBindings<T> {
  const bound = new Map<string, GenSlotBinding<T>>();
  const conflicts = new Set<string>();

  for (const entry of entries) {
    for (const output of activeOutputs(entry.graph)) {
      if (output.slot.length === 0) {
        continue;
      }
      if (bound.has(output.slot)) {
        conflicts.add(output.slot);
        continue;
      }
      bound.set(output.slot, { entry, target: output.id });
    }
  }

  for (const slot of conflicts) {
    bound.delete(slot);
  }

  return { bound, conflicts: [...conflicts] };
}
