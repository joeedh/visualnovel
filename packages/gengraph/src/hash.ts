import { hashParts } from '@vn/util';
import type { Graph, GraphId, Node } from 'pathux-graph';

import { flattenNodes, nodeKey } from './nodekey.js';
import { genNodeSpec } from './registry.js';

/** What the host resolves an empty prop to, hashed in the prop's place so the run keys on it. */
export interface GenHashDefaults {
  /** The project's image model, read by a node whose spec names an `imageModelProp`. */
  imageModel?: string;
}

/**
 * A node's content address: its type and version, its authored props, and whatever
 * feeds each of its inputs. Identity, label and position are deliberately absent, so
 * moving a node in the editor cannot re-run it.
 *
 * The caller decides what each input contributes. A connected input contributes the
 * hash of the node feeding it, which is how an edit propagates to everything below it;
 * a picture contributes its content hash rather than its bytes.
 *
 * An image node whose model prop is empty draws with the project's image model, so that
 * model is hashed in the prop's place when `defaults` carries it. Without it the empty
 * prop hashes as written, and a change of project model would resume the old picture.
 */
export function nodeHash(
  node: Node,
  inputs: Readonly<Record<string, unknown>>,
  defaults: GenHashDefaults = {},
): string {
  const props: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(node.props)) {
    props[key] = prop.getValue();
  }

  const modelProp = genNodeSpec(node.def.typeName)?.imageModelProp;
  if (
    modelProp !== undefined &&
    defaults.imageModel !== undefined &&
    String(props[modelProp] ?? '').trim() === ''
  ) {
    props[modelProp] = defaults.imageModel;
  }

  // hashParts canonicalizes each part, sorting object keys recursively, so neither
  // record needs an ordering of its own.
  return hashParts(`${node.def.typeName}@${node.typeVersion}`, props, inputs);
}

/**
 * A node's run key: the same parts as `nodeHash`, resolved the same way, with each input
 * contributing the value on its socket rather than the hash of the node feeding it. Two
 * runs with the same key were fed the same bytes, which is what the executor resumes on.
 * It exists only during a run, because the socket values do.
 */
export function nodeRunKey(
  node: Node,
  values: Readonly<Record<string, unknown>>,
  defaults: GenHashDefaults = {},
): string {
  return nodeHash(node, values, defaults);
}

/**
 * Every node's hash, keyed by node key and computed in topological order over the
 * flattened graph, so a node inside an instance is hashed as part of its root. A connected
 * input contributes the hash of the node feeding it together with the socket it came from;
 * an unconnected input contributes its own default value, which is where a host's seeded
 * prompt reaches the hash; an input reaching an instance's boundary default through the
 * group's proxy contributes that default, so two instances differing only there hash apart.
 * Nodes inside a cycle are absent from the result, because a hash there would have to
 * contain itself.
 */
export function graphHashes(graph: Graph, defaults: GenHashDefaults = {}): Map<GraphId, string> {
  return walk(graph, false, defaults);
}

/**
 * Every node's hash over the authored graph alone, with each host-seeded input read as
 * though nothing had been seeded onto it and an empty model prop hashed as written.
 * `graphHashes` moves with the task a run was for, so this is the quantity that answers
 * whether the graph itself was edited.
 */
export function authoredHashes(graph: Graph): Map<GraphId, string> {
  return walk(graph, true, {});
}

function walk(
  graph: Graph,
  authoredOnly: boolean,
  defaults: GenHashDefaults,
): Map<GraphId, string> {
  const hashes = new Map<GraphId, string>();
  const members = new Set(flattenNodes(graph));

  for (const node of graph.sort().order) {
    const inputs: Record<string, unknown> = {};
    const seeded = authoredOnly ? genNodeSpec(node.def.typeName)?.seededInput : undefined;

    for (const [key, sock] of Object.entries(node.inputs)) {
      const sources = sock.resolvedEdges();

      if (sources.length === 0) {
        inputs[key] = key === seeded ? null : (sock.defaultProp?.getValue() ?? null);
        continue;
      }

      const linked = sources.filter((src) => members.has(src.owningNode as Node));
      if (linked.length === 0) {
        // The instance's own socket standing in for an unmade link; its default is what runs.
        inputs[key] = sources[0]!.defaultProp?.getValue() ?? null;
        continue;
      }

      // Sorted, so that reconnecting the same set of edges in another order is not an edit.
      inputs[key] = linked
        .map((src) => `${hashes.get(nodeKey(src.owningNode as Node)) ?? ''}:${src.name}`)
        .sort();
    }

    hashes.set(nodeKey(node), nodeHash(node, inputs, defaults));
  }

  return hashes;
}
