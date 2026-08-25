import { hashParts } from '@vn/util';
import { NO_ID } from 'pathux-graph';
import type { Graph, GraphId, Node } from 'pathux-graph';

/**
 * A node's content address: its type and version, its authored props, and whatever
 * feeds each of its inputs. Identity, label and position are deliberately absent, so
 * moving a node in the editor cannot re-run it.
 *
 * The caller decides what each input contributes. A connected input contributes the
 * hash of the node feeding it, which is how an edit propagates to everything below it;
 * a picture contributes its content hash rather than its bytes.
 */
export function nodeHash(node: Node, inputs: Readonly<Record<string, unknown>>): string {
  const props: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(node.props)) {
    props[key] = prop.getValue();
  }

  // hashParts canonicalizes each part, sorting object keys recursively, so neither
  // record needs an ordering of its own.
  return hashParts(`${node.def.typeName}@${node.typeVersion}`, props, inputs);
}

/**
 * Every node's hash, keyed by node id and computed in topological order. A connected
 * input contributes the hash of the node feeding it together with the socket it came
 * from; an unconnected input contributes its own default value. Nodes inside a cycle
 * are absent from the result, because a hash there would have to contain itself.
 */
export function graphHashes(graph: Graph): Map<GraphId, string> {
  const hashes = new Map<GraphId, string>();

  for (const node of graph.sort().order) {
    const inputs: Record<string, unknown> = {};

    for (const [key, sock] of Object.entries(node.inputs)) {
      const sources = sock.resolvedEdges();

      if (sources.length === 0) {
        inputs[key] = sock.defaultProp?.getValue() ?? null;
        continue;
      }

      // Sorted, so that reconnecting the same set of edges in another order is not an edit.
      inputs[key] = sources
        .map((src) => `${hashes.get(src.owningNode?.id ?? NO_ID) ?? ''}:${src.name}`)
        .sort();
    }

    hashes.set(node.id, nodeHash(node, inputs));
  }

  return hashes;
}
