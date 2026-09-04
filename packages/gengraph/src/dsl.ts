import { Graph, GroupNode, SocketClasses, buildGraphFromDSL } from 'pathux-graph';
import type {
  DSLDiagnostic,
  GraphDSL,
  GraphDSLLink,
  GraphDSLNode,
  GraphId,
  GroupDef,
  Node,
  NodeTypeConstructor,
} from 'pathux-graph';

import { genNodeTypes } from './registry.js';

/** How the graph changed when a description was applied to it, all by node id. */
export interface GraphDSLApply {
  /** The graph the description describes. Kept nodes carry their old layout over. */
  graph: Graph;
  /**
   * Everything wrong with the description. A bad entry was dropped rather than thrown
   * on, so the graph is what could be salvaged; the caller decides whether to keep it.
   */
  diagnostics: DSLDiagnostic[];
  kept: GraphId[];
  added: GraphId[];
  removed: GraphId[];
}

/** Column height, in nodes, before placement starts the next column. */
const PLACE_ROWS = 6;
const PLACE_GAP = 40;

/**
 * The description an agent reads and writes. It carries topology and authored values
 * and no layout at all, so re-authoring a graph never moves what the author arranged.
 * A prop equal to its type's default is left out, which keeps the description short
 * without changing what it builds. A group instance is one entry naming its definition;
 * what is inside the group, and any override on it, is the group's own business.
 */
export function graphToDSL(graph: Graph): GraphDSL {
  const nodes: GraphDSLNode[] = [];
  const links: GraphDSLLink[] = [];

  for (const node of graph.nodes) {
    const entry: GraphDSLNode = { id: node.id, type: node.def.typeName };

    if (node instanceof GroupNode) {
      entry.group = node.ref;
    } else {
      const props = authoredProps(node);
      if (Object.keys(props).length > 0) {
        entry.props = props;
      }
    }
    nodes.push(entry);

    for (const [key, sock] of Object.entries(node.inputs)) {
      // The authored edges rather than the resolved ones: a group's proxy sockets are
      // the group's own business and are not part of what an agent wrote.
      for (const src of sock.edges) {
        const from = src.owningNode?.id;
        if (from !== undefined) {
          links.push([from, src.name, node.id, key]);
        }
      }
    }
  }

  return { nodes, links };
}

/**
 * Builds the described graph and diffs it against the live one by node id. A node that
 * survives keeps its position, size and label, and keeps its id, which is what leaves its
 * run journal addressable. Nodes the description adds are placed by {@link placeNewNodes}.
 *
 * A group instance builds against a definition: the ones the live graph's instances had
 * already resolved, and `groups`, the library the caller loaded, which is what lets the
 * description add an instance of a definition the graph did not hold before. An instance
 * kept under its id and ref keeps its overrides. An id holding a `/` is refused, because
 * that is how a node inside a group is addressed and an id must never read as one.
 *
 * The description is a parsed JSON value or the JSON text of one. Replacing the whole
 * graph is the only edit this path offers; a partial change is what the commands are for.
 */
export function applyGraphDSL(
  graph: Graph,
  input: unknown,
  groups?: ReadonlyMap<string, GroupDef>,
): GraphDSLApply {
  const read = readDescription(input);
  const early = read.diagnostic ?? keyLikeId(read.value);
  if (early !== undefined) {
    return {
      graph,
      diagnostics: [early],
      kept: graph.nodes.map((n) => n.id),
      added: [],
      removed: [],
    };
  }

  const known = new Map<string, GroupDef>(groups ?? []);
  for (const node of graph.nodes) {
    if (node instanceof GroupNode && node.definition !== undefined && !known.has(node.ref)) {
      known.set(node.ref, node.definition);
    }
  }

  const built = buildGraphFromDSL(read.value, {
    nodeTypes: new Map([...genNodeTypes(), ['GroupNode', GroupNode as NodeTypeConstructor]]),
    socketTypes: SocketClasses,
    groups: known,
  });

  const before = new Map<GraphId, Node>();
  for (const node of graph.nodes) {
    before.set(node.id, node);
  }

  const kept: GraphId[] = [];
  const added: GraphId[] = [];
  const placed: Node[] = [];
  const fresh: Node[] = [];

  for (const node of built.graph.nodes) {
    const old = before.get(node.id);

    if (old === undefined) {
      added.push(node.id);
      fresh.push(node);
      continue;
    }

    node.pos[0] = old.pos[0];
    node.pos[1] = old.pos[1];
    node.size[0] = old.size[0];
    node.size[1] = old.size[1];
    node.label = old.label;
    if (old instanceof GroupNode && node instanceof GroupNode && old.ref === node.ref) {
      carryOverrides(old, node);
    }

    kept.push(node.id);
    placed.push(node);
  }

  const removed = [...before.keys()].filter((id) => !built.graph.nodeIdMap.has(id));

  placeNewNodes(placed, fresh);

  return { graph: built.graph, diagnostics: built.diagnostics, kept, added, removed };
}

/**
 * Places nodes to the right of everything already placed, filling a column of
 * {@link PLACE_ROWS} before starting the next one. path.ux's auto-arrange replaces this,
 * which is why it is one pure call rather than something spread through the diff.
 */
export function placeNewNodes(placed: readonly Node[], fresh: readonly Node[]): void {
  if (fresh.length === 0) {
    return;
  }

  let originX = 0;
  let originY = 0;

  if (placed.length > 0) {
    originX = Math.max(...placed.map((n) => n.pos[0] + n.size[0])) + PLACE_GAP;
    originY = Math.min(...placed.map((n) => n.pos[1]));
  }

  const width = Math.max(...fresh.map((n) => n.size[0]));
  const height = Math.max(...fresh.map((n) => n.size[1]));

  fresh.forEach((node, i) => {
    node.pos[0] = originX + Math.floor(i / PLACE_ROWS) * (width + PLACE_GAP);
    node.pos[1] = originY + (i % PLACE_ROWS) * (height + PLACE_GAP);
  });
}

/**
 * Moves a kept instance's overrides onto its rebuilt copy: the inner values its subgraph
 * holds, which reconciling against the definition transplants, and the boundary defaults
 * set on its own sockets. The description never carries a boundary default, since
 * `graphToDSL` leaves an instance's values to the instance, so the old node's are the
 * only ones there are.
 */
function carryOverrides(old: GroupNode, node: GroupNode): void {
  if (node.definition !== undefined) {
    node.subgraph = old.subgraph;
    old.subgraph.groupOwner = node;
    node.syncToDefinition();
  }

  for (const [key, sock] of Object.entries(old.inputs)) {
    const from = sock.defaultProp;
    const to = node.inputs[key]?.defaultProp;
    if (from?.wasSet !== true || to === undefined || from.constructor !== to.constructor) {
      continue;
    }
    to.setValue(from.getValue());
    to.wasSet = true;
  }
}

/** The diagnostic for a node id written like a node key, or undefined when none is. */
function keyLikeId(value: unknown): DSLDiagnostic | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const nodes = (value as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return undefined;

  for (const [i, entry] of nodes.entries()) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id.includes('/')) {
      const path = `nodes[${i}]`;
      return {
        code: 'bad-node-id',
        message: `${path}: id '${id}' holds a '/', which is how a node inside a group is addressed`,
        path,
      };
    }
  }
  return undefined;
}

const probes = new Map<string, Node>();

/** Prop and input-default values that differ from a freshly built node of the same type. */
function authoredProps(node: Node): Record<string, unknown> {
  const probe = probeFor(node);
  const out: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(node.props)) {
    const value = prop.getValue();
    if (!sameValue(value, probe.props[key]?.getValue())) {
      out[key] = value;
    }
  }

  for (const [key, sock] of Object.entries(node.inputs)) {
    // A prop and an input default under one key is the prop, because that is which of
    // the two the builder writes to.
    if (sock.defaultProp === undefined || key in node.props) {
      continue;
    }

    const value = sock.defaultProp.getValue();
    if (!sameValue(value, probe.inputs[key]?.defaultProp?.getValue())) {
      out[key] = value;
    }
  }

  return out;
}

function probeFor(node: Node): Node {
  const name = node.def.typeName;
  let probe = probes.get(name);

  if (probe === undefined) {
    probe = new (node.constructor as NodeTypeConstructor)();
    probes.set(name, probe);
  }
  return probe;
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function readDescription(input: unknown): { value?: unknown; diagnostic?: DSLDiagnostic } {
  if (typeof input !== 'string') {
    return { value: input };
  }

  try {
    return { value: JSON.parse(input) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      diagnostic: { code: 'bad-json', message: `the description is not JSON: ${detail}`, path: '' },
    };
  }
}
