import type { Graph, GraphId } from 'pathux-graph';

import { authoredHashes } from './hash.js';
import type { GraphJournal } from './journal.js';
import { genNodeSpec } from './registry.js';

/** One output node whose graph no longer matches what its last run recorded. */
export interface GenGraphDrift {
  nodeId: GraphId;
  /** The authored hash the graph would produce now. */
  current: string;
  /** The authored hash the node's last completed run recorded. */
  recorded: string;
}

/**
 * Reports the output nodes whose authored hash has moved since they last ran, which is the
 * signal a host redraws the drifted slot from. Authored hashes are compared rather than run
 * hashes, because a run hash also carries the prompt and references the host seeded for the
 * task, and those move with the task rather than with the graph.
 *
 * A node that has never completed a run is not drift, because there is nothing for it to have
 * drifted from, and neither is one whose last record predates the authored hash.
 */
export function graphDrift(graph: Graph, journal: GraphJournal): GenGraphDrift[] {
  const hashes = authoredHashes(graph);
  const drifted: GenGraphDrift[] = [];

  for (const node of graph.nodes) {
    if (genNodeSpec(node.def.typeName)?.slotProp === undefined) {
      continue;
    }

    const current = hashes.get(node.id);
    const recorded = journal.lastDone.get(node.id)?.authoredHash;

    if (current !== undefined && recorded !== undefined && current !== recorded) {
      drifted.push({ nodeId: node.id, current, recorded });
    }
  }

  return drifted;
}
