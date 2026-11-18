/**
 * How a node is addressed once a graph holds groups: by its key, the chain of ids from the root,
 * which is a root node's own id and `<owner key>/<id>` for a node inside an instance.
 */
import { contract } from '@vn/contracts';
import { GroupNode } from 'pathux-graph';
import type { Graph, GraphId, Node, NodeSocketBase } from 'pathux-graph';

export const graphsGroupNodeKey = contract({
  id      : 'graphs.groupNodeKey',
  rule: "A node in a generation graph is addressed by its key, the chain of ids from the root (`3/7` for node 7 inside instance 3), never by its id alone. The hashes, the journal, the executor's targets, the cost walk and every `gengraph.*` command's `node` prop use it.",
  prevents:
    "A node inside a group instance sharing its id with a root node, since every graph's ids start at zero, so the two would share a hash, a journal record or a command target.",
  subjects: [
    'module:packages/gengraph/src/nodekey.ts',
    'function:packages/gengraph/src/nodekey.ts#nodeKey',
    'function:packages/gengraph/src/nodekey.ts#resolveNodeKey',
    'command:gengraph.setProp',
  ],
  see: [
    'docs/reference/gen-graphs.md#groups',
    'docs/plans/archive/group-nodes-in-the-gen-graph-editor.md',
  ],
  detail:
    "A root node's key is its id, so keys in a graph with no groups are unchanged and a journal " +
    'written before groups existed still matches its nodes. Every `node` prop on a `gengraph.*` ' +
    "command resolves through `resolveNodeKey`, so the pane writes an instance's override as " +
    "`gengraph.setProp` on `<instance>/<id>`, and the agent's whole-graph rewrite keeps an instance " +
    'under `group: <ref>`.',
});

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
 * The refs of every definition this graph reaches: its own instances and, through their
 * subgraphs, the definitions those instance in turn. Each ref once, in the order first met.
 */
export function instancedRefs(graph: Graph): string[] {
  const out: string[] = [];
  const walk = (scope: Graph): void => {
    for (const node of scope.nodes) {
      if (!(node instanceof GroupNode)) continue;
      if (!out.includes(node.ref)) out.push(node.ref);
      walk(node.subgraph);
    }
  };
  walk(graph);
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
