import type { Graph, GraphId } from 'pathux-graph';

import { graphHashes } from './hash.js';
import type { GraphJournal } from './journal.js';
import { genNodeSpec } from './registry.js';

/** One output node whose graph no longer matches what its last run recorded. */
export interface GenGraphDrift {
  nodeId: GraphId;
  /** The hash the graph would produce now. */
  current: string;
  /** The hash the node's last completed run recorded. */
  recorded: string;
}

/**
 * Reports the output nodes whose hash has moved since they last ran. Nothing is
 * invalidated and nothing is deleted: a drifted node keeps the asset it filled its slot
 * with until someone re-runs it, which is the posture `Shot.proseHash` takes for prose.
 * A node that has never completed a run is not drift, because there is nothing for it to
 * have drifted from.
 */
export function graphDrift(graph: Graph, journal: GraphJournal): GenGraphDrift[] {
  const hashes = graphHashes(graph);
  const drifted: GenGraphDrift[] = [];

  for (const node of graph.nodes) {
    if (genNodeSpec(node.def.typeName)?.slotProp === undefined) {
      continue;
    }

    const current = hashes.get(node.id);
    const recorded = journal.lastDone.get(node.id)?.nodeHash;

    if (current !== undefined && recorded !== undefined && current !== recorded) {
      drifted.push({ nodeId: node.id, current, recorded });
    }
  }

  return drifted;
}
