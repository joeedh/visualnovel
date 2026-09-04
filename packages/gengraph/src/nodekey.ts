/**
 * How a node is addressed once a graph holds groups. A node's id is unique only within its
 * own graph, and every graph's ids start at zero, so a node inside an instance can share an
 * id with a root node. Its key is the chain of ids from the root: a root node's own id, and
 * `<owner key>/<id>` for a node inside an instance. Root keys are the ids they always were,
 * so a journal written before groups existed still matches its nodes.
 */
import { GroupNode } from 'pathux-graph';
import type { Graph, GraphId, Node, NodeSocketBase } from 'pathux-graph';

/** The key the hashes, the journal and the executor address this node by. */
export function nodeKey(node: Node): GraphId {
  const owner = node.graph?.groupOwner;
  return owner === undefined ? node.id : `${String(nodeKey(owner))}/${String(node.id)}`;
}

/** True for a key that reaches inside an instance, which is what a `/` in it means. */
export function isNodeKey(key: GraphId): key is string {
  return typeof key === 'string' && key.includes('/');
}

/** The node a key names, walking into each instance in turn; undefined where the chain breaks. */
export function resolveNodeKey(graph: Graph, key: GraphId): Node | undefined {
  if (!isNodeKey(key)) return graph.nodeIdMap.get(key);

  let scope = graph;
  let node: Node | undefined;
  for (const part of key.split('/')) {
    if (node !== undefined) {
      if (!(node instanceof GroupNode)) return undefined;
      scope = node.subgraph;
    }
    node = scope.nodeIdMap.get(idIn(scope, part));
    if (node === undefined) return undefined;
  }
  return node;
}

/** One segment as the id its graph keys it by: the string where that names a node, else the number. */
function idIn(graph: Graph, part: string): GraphId {
  if (graph.nodeIdMap.has(part)) return part;
  const num = Number(part);
  return Number.isInteger(num) ? num : part;
}

/** Every node that runs, each instance expanded to its inner nodes recursively, in graph order. */
export function flattenNodes(graph: Graph): Node[] {
  const out: Node[] = [];
  for (const node of graph.nodes) out.push(...node.expandNode());
  return out;
}

/**
 * The sources feeding an input whose owners are among `members`. A source outside them is a
 * boundary default reached through a proxy: an instance's own socket standing in for a link
 * that was never made, which contributes a value rather than an upstream node.
 */
export function linkedSources(sock: NodeSocketBase, members: ReadonlySet<Node>): NodeSocketBase[] {
  return sock.resolvedEdges().filter((src) => members.has(src.owningNode as Node));
}
