/**
 * The rules one edit to a generation graph must pass, decided before anything is changed.
 * A host asks `decideGenEdit` what an edit would do, shows or returns the refusal, and calls
 * the decision's `apply` only once it means to write. The desktop commands and the authoring
 * agent's graph tool both go through here, so a refusal reads the same in both.
 *
 * A node is named by its key, so an edit reaches a node inside a group instance. Only a value
 * edit is allowed there: the instance's subgraph refuses structural edits with path.ux's own
 * sentence, and those belong to the definition, whose subgraph is a plain graph this decides
 * against like any other. The boundary and forwarded-row edits apply only to a definition's
 * subgraph, which is how they find the definition they edit.
 */
import { parseSlot } from '@vn/artgen/slotaddr';
import {
  GroupInputNode,
  GroupNode,
  GroupOutputNode,
  Node as GraphNode,
  addBoundary,
  cloneNode,
  createGroup,
  definitionOfSubgraph,
  exposeEntry,
  getSocketClass,
  groupPlan,
  isRefusal,
  nodePropTarget,
  removeBoundary,
  removeEntry,
  reorderEntry,
  repointEntry,
  ungroup,
} from 'pathux-graph';
import type {
  ExposedEntry,
  Graph,
  GraphId,
  GroupDef,
  Node,
  NodePropName,
  NodeSocketBase,
  SocketDir,
} from 'pathux-graph';
import { PropTypes } from 'pathux-toolprop';
import type { ToolProperty } from 'pathux-toolprop';

import { applyGraphDSL, placeNewNodes } from './dsl.js';
import { resolveNodeKey } from './nodekey.js';
import { genNodeSpec, genNodeTypes } from './registry.js';
import { isGraphSlug } from './slug.js';

/** A value an authored prop can hold. Anything richer is edited through the whole-DSL path. */
export type GenPropValue = string | number | boolean;

export type GenEdit =
  | { op: 'addNode'; type: string; pos?: readonly [number, number] }
  /** Copies a node, ref and overrides included, onto a fresh node with a fresh id. */
  | { op: 'duplicateNode'; node: GraphId; pos?: readonly [number, number] }
  | { op: 'removeNode'; node: GraphId }
  | { op: 'link'; from: GraphId; fromSocket: string; to: GraphId; toSocket: string }
  /** Severs one named link, or every link into `toSocket` when no source is named. */
  | { op: 'unlink'; to: GraphId; toSocket: string; from?: GraphId; fromSocket?: string }
  | { op: 'setProp'; node: GraphId; key: string; value: GenPropValue }
  | { op: 'setActiveOutput'; node: GraphId }
  /** Where nodes now sit. One drag moves every node it caught, so a move takes a list. */
  | { op: 'moveNodes'; moves: readonly GenNodeMove[] }
  /**
   * Moves the named nodes into a new definition under `ref` and puts an instance in their place.
   * Without `ref` the edit can be judged but not applied: a host that allocates refs elsewhere
   * judges it before sending, and only the allocating side applies it.
   */
  | { op: 'createGroup'; nodes: readonly GraphId[]; ref?: string }
  /** Inlines a copy of an instance's subgraph, overrides included, where the instance stood. */
  | { op: 'ungroup'; node: GraphId }
  /** Adds an instance of `ref`. With `def` given it is bound at once; otherwise the caller resolves it. */
  | { op: 'addGroup'; ref: string; def?: GroupDef; pos?: readonly [number, number] }
  /** Adds a forwarded row to the definition this graph is the subgraph of. `key` is a `NodePropName`. */
  | {
      op: 'expose';
      kind: 'prop' | 'nodeUI';
      node: GraphId;
      key?: string;
      label?: string;
      at?: number;
    }
  | { op: 'unexpose'; index: number }
  | { op: 'reorderExposed'; from: number; to: number }
  | { op: 'repointExposed'; index: number; node: GraphId; key?: string }
  /** Declares a boundary socket of a registered socket type on the definition. */
  | { op: 'addBoundary'; dir: SocketDir; key: string; type: string }
  | { op: 'removeBoundary'; dir: SocketDir; key: string }
  /** Replaces the graph from a description; `groups` is the library its instances build against. */
  | { op: 'apply'; description: unknown; groups?: ReadonlyMap<string, GroupDef> };

/** One node's new position in graph space. */
export interface GenNodeMove {
  node: GraphId;
  x: number;
  y: number;
}

/** What an applied edit left behind. */
export interface GenApplied {
  /** The edited graph. A whole-DSL apply answers with a rebuilt graph rather than this one. */
  graph: Graph;
  /** The node the edit created, which a host reports and selects. */
  node?: GraphId;
  /** The definitions the edit created, which the host writes beside the graph. */
  definitions?: { ref: string; def: GroupDef }[];
}

export interface GenEditDecision {
  /** One sentence saying what applying it would do, for a precondition to report. */
  note: string;
  apply(): GenApplied;
}

export type GenEditResult =
  | ({ ok: true } & GenEditDecision)
  | {
      ok: false;
      reason: string;
      /**
       * Every problem found, when the edit was refused over more than one. A host that can
       * show a list shows this, and one that has room for a sentence shows `reason` alone.
       */
      details?: string[];
    };

const refuse = (reason: string, details?: string[]): GenEditResult => ({
  ok: false,
  reason,
  ...(details === undefined ? {} : { details }),
});

/**
 * Decides one edit against the graph as it stands. Nothing here writes, so a host may call it
 * from a precondition and again from the write itself and get the same answer both times.
 */
export function decideGenEdit(graph: Graph, edit: GenEdit): GenEditResult {
  switch (edit.op) {
    case 'addNode':
      return decideAdd(graph, edit);
    case 'duplicateNode':
      return decideDuplicate(graph, edit);
    case 'removeNode':
      return decideRemove(graph, edit);
    case 'link':
      return decideLink(graph, edit);
    case 'unlink':
      return decideUnlink(graph, edit);
    case 'setProp':
      return decideSetProp(graph, edit);
    case 'setActiveOutput':
      return decideSetActive(graph, edit);
    case 'moveNodes':
      return decideMove(graph, edit);
    case 'createGroup':
      return decideCreateGroup(graph, edit);
    case 'ungroup':
      return decideUngroup(graph, edit);
    case 'addGroup':
      return decideAddGroup(graph, edit);
    case 'expose':
      return decideExpose(graph, edit);
    case 'unexpose':
      return decideUnexpose(graph, edit);
    case 'reorderExposed':
      return decideReorder(graph, edit);
    case 'repointExposed':
      return decideRepoint(graph, edit);
    case 'addBoundary':
      return decideAddBoundary(graph, edit);
    case 'removeBoundary':
      return decideRemoveBoundary(graph, edit);
    case 'apply':
      return decideApply(graph, edit);
  }
}

function decideAdd(graph: Graph, edit: GenEdit & { op: 'addNode' }): GenEditResult {
  const refused = graph.structuralEditsRefused();
  if (refused !== undefined) return refuse(refused);

  const cls = genNodeTypes().get(edit.type);
  if (cls === undefined) {
    return refuse(
      `there is no node type '${edit.type}' registered here; the plugin providing it may not be installed`,
    );
  }

  const declared = cls.graphDef().uiName;
  const uiName = typeof declared === 'string' ? declared : edit.type;
  return {
    ok   : true,
    note : `Adds a ${uiName} node.`,
    apply: () => {
      const node = new cls();
      place(graph, node, edit.pos);
      graph.add(node);
      return { graph, node: node.id };
    },
  };
}

/**
 * Copies a node with a freshly allocated id, so the copy starts with no run journal of its own —
 * its hash has never matched a record, and it runs the first time the graph does. Links do not
 * travel, the same as path.ux's own duplicate; an instance's ref and overrides do.
 */
function decideDuplicate(graph: Graph, edit: GenEdit & { op: 'duplicateNode' }): GenEditResult {
  const source = resolveNodeKey(graph, edit.node);
  if (source === undefined) return refuse(missing(edit.node));
  const refused = structuralRefusal(graph, source);
  if (refused !== undefined) return refuse(refused);

  return {
    ok   : true,
    note : `Adds a copy of the ${nameOf(source)} node.`,
    apply: () => {
      const node = cloneNode(source);
      place(graph, node, edit.pos);
      graph.add(node);
      return { graph, node: node.id };
    },
  };
}

/** Puts a new node where the edit asks, or clear of everything already placed. */
function place(graph: Graph, node: Node, pos: readonly [number, number] | undefined): void {
  if (pos === undefined) {
    placeNewNodes(graph.nodes, [node]);
  } else {
    node.pos[0] = pos[0];
    node.pos[1] = pos[1];
  }
}

function decideRemove(graph: Graph, edit: GenEdit & { op: 'removeNode' }): GenEditResult {
  const node = resolveNodeKey(graph, edit.node);
  if (node === undefined) return refuse(missing(edit.node));
  const refused = structuralRefusal(graph, node);
  if (refused !== undefined) return refuse(refused);

  const links = linkCount(node);
  const carried = links === 0 ? '' : ` and the ${plural(links, 'link')} it carries`;
  return {
    ok   : true,
    note : `Removes the ${nameOf(node)} node${carried}.`,
    apply: () => {
      graph.remove(node);
      return { graph };
    },
  };
}

function decideLink(graph: Graph, edit: GenEdit & { op: 'link' }): GenEditResult {
  const from = resolveNodeKey(graph, edit.from);
  const to = resolveNodeKey(graph, edit.to);
  if (from === undefined) return refuse(missing(edit.from));
  if (to === undefined) return refuse(missing(edit.to));
  const refused = structuralRefusal(graph, from) ?? structuralRefusal(graph, to);
  if (refused !== undefined) return refuse(refused);

  const src = from.outputs[edit.fromSocket];
  if (src === undefined) {
    return refuse(`node type '${from.def.typeName}' declares no output '${edit.fromSocket}'`);
  }
  const dst = to.inputs[edit.toSocket];
  if (dst === undefined) {
    return refuse(`node type '${to.def.typeName}' declares no input '${edit.toSocket}'`);
  }

  if (!dst.coerce(src, { dryRun: true })) {
    return refuse(`a '${src.type}' output cannot feed the '${dst.type}' input '${edit.toSocket}'`);
  }
  if (reachesUpstream(from, to)) {
    return refuse('linking these makes a cycle, and a cycle has no order to run in');
  }

  const replaced = !dst.multiSocket && dst.edges.length > 0;
  const note = replaced
    ? `Rewires '${edit.toSocket}' on the ${nameOf(to)} node, replacing what feeds it.`
    : `Feeds '${edit.toSocket}' on the ${nameOf(to)} node from the ${nameOf(from)} node.`;

  return {
    ok: true,
    note,
    apply: () => {
      graph.connect(src, dst);
      return { graph };
    },
  };
}

function decideUnlink(graph: Graph, edit: GenEdit & { op: 'unlink' }): GenEditResult {
  const to = resolveNodeKey(graph, edit.to);
  if (to === undefined) return refuse(missing(edit.to));
  const refused = structuralRefusal(graph, to);
  if (refused !== undefined) return refuse(refused);

  const dst = to.inputs[edit.toSocket];
  if (dst === undefined) {
    return refuse(`node type '${to.def.typeName}' declares no input '${edit.toSocket}'`);
  }

  if (edit.from === undefined) {
    if (dst.edges.length === 0) {
      return refuse(`nothing feeds '${edit.toSocket}' on the ${nameOf(to)} node`);
    }
    const edges = [...dst.edges];
    return {
      ok   : true,
      note: `Severs the ${plural(edges.length, 'link')} into '${edit.toSocket}' on the ${nameOf(to)} node.`,
      apply: () => {
        for (const src of edges) graph.disconnect(src, dst);
        return { graph };
      },
    };
  }

  const from = resolveNodeKey(graph, edit.from);
  if (from === undefined) return refuse(missing(edit.from));

  const src = edit.fromSocket === undefined ? undefined : from.outputs[edit.fromSocket];
  const named = src === undefined ? dst.edges.find((e) => e.owningNode === from) : src;
  if (named === undefined || !dst.edges.includes(named)) {
    return refuse(
      `the ${nameOf(from)} node does not feed '${edit.toSocket}' on the ${nameOf(to)} node`,
    );
  }

  return {
    ok   : true,
    note : `Severs the link from the ${nameOf(from)} node into '${edit.toSocket}'.`,
    apply: () => {
      graph.disconnect(named, dst);
      return { graph };
    },
  };
}

/** A node's own prop by that key, else the matching input socket's editable default. */
function resolveNodeProp(node: Node, key: string): ToolProperty | undefined {
  return (
    nodePropTarget(node, GraphNode.composePropName('prop', key)) ??
    nodePropTarget(node, GraphNode.composePropName('in', key))
  );
}

function decideSetProp(graph: Graph, edit: GenEdit & { op: 'setProp' }): GenEditResult {
  const node = resolveNodeKey(graph, edit.node);
  if (node === undefined) return refuse(missing(edit.node));

  const prop = resolveNodeProp(node, edit.key);
  if (prop === undefined) {
    return refuse(
      `node type '${node.def.typeName}' declares no prop or editable input '${edit.key}'`,
    );
  }

  const wanted = valueKind(prop);
  if (wanted !== undefined && typeof edit.value !== wanted) {
    return refuse(`'${edit.key}' on a ${nameOf(node)} node takes a ${wanted} value`);
  }

  if (genNodeSpec(node.def.typeName)?.slotProp === edit.key) {
    const bad = slotRefusal(String(edit.value));
    if (bad !== undefined) return refuse(bad);
  }

  return {
    ok   : true,
    note : `Sets '${edit.key}' on the ${nameOf(node)} node to ${JSON.stringify(edit.value)}.`,
    apply: () => {
      prop.setValue(edit.value);
      return { graph };
    },
  };
}

/**
 * Checks the slot an output node names. Wording matches `validateGenGraph`, so an author
 * reads the same sentence whether the slot was refused at the edit or reported on a load.
 */
export function slotRefusal(said: string): string | undefined {
  const slot = said.trim();
  // An empty slot is how an unbound graph is authored, so clearing one is a real edit.
  if (slot === '') return undefined;

  const binding = parseSlot(slot);
  if (binding === undefined) return `'${slot}' is not a slot address`;
  if (binding.kind === 'asset') {
    return `'${slot}' addresses an asset rather than a slot, and an asset is fixed content that nothing can fill`;
  }
  return undefined;
}

function decideSetActive(graph: Graph, edit: GenEdit & { op: 'setActiveOutput' }): GenEditResult {
  const node = resolveNodeKey(graph, edit.node);
  if (node === undefined) return refuse(missing(edit.node));
  if (node.graph !== graph) {
    return refuse(
      `the ${nameOf(node)} node sits inside a group, and an active output belongs to the graph itself`,
    );
  }

  const key = genNodeSpec(node.def.typeName)?.slotProp;
  const active = node.props.active;
  if (key === undefined || active === undefined) {
    return refuse(`the ${nameOf(node)} node fills no slot, so it cannot be an active output`);
  }

  const slot = String(node.props[key]?.getValue() ?? '').trim();
  // Only the outputs claiming this slot step aside. Two outputs on two slots are both live,
  // and it is one slot claimed twice that leaves a task with no graph to draw through.
  const rivals = graph.nodes.filter((other) => other !== node && claims(other, slot));

  const stood = rivals.length === 0 ? '' : `, and stands ${plural(rivals.length, 'output')} down`;
  const named = slot === '' ? 'the slot it names' : `'${slot}'`;

  return {
    ok   : true,
    note : `Makes this the output run for ${named}${stood}.`,
    apply: () => {
      active.setValue(true);
      for (const other of rivals) other.props.active?.setValue(false);
      return { graph };
    },
  };
}

/** Whether a node is an output claiming this slot, whatever its active flag currently says. */
function claims(node: Node, slot: string): boolean {
  const key = genNodeSpec(node.def.typeName)?.slotProp;
  if (key === undefined || node.props.active === undefined) return false;
  return String(node.props[key]?.getValue() ?? '').trim() === slot;
}

/**
 * Decides a drag. Every node named must exist and land on a finite position, because the whole
 * drag is written as one edit and a graph half-moved reads as a layout the author never made.
 * A node inside an instance cannot be moved: its layout is the definition's.
 */
function decideMove(graph: Graph, edit: GenEdit & { op: 'moveNodes' }): GenEditResult {
  if (edit.moves.length === 0) return refuse('this move names no node');

  const problems: string[] = [];
  const moved: { node: Node; x: number; y: number }[] = [];

  for (const move of edit.moves) {
    const node = resolveNodeKey(graph, move.node);
    if (node === undefined) {
      problems.push(missing(move.node));
      continue;
    }
    const refused = structuralRefusal(graph, node);
    if (refused !== undefined) {
      problems.push(refused);
      continue;
    }
    if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) {
      problems.push(`the ${nameOf(node)} node was moved to a position that is not a number`);
      continue;
    }
    moved.push({ node, x: move.x, y: move.y });
  }

  const first = problems[0];
  if (first !== undefined) return refuse(first, problems);

  const what =
    moved.length === 1 ? `the ${nameOf(moved[0]!.node)} node` : plural(moved.length, 'node');
  return {
    ok   : true,
    note : `Moves ${what}.`,
    apply: () => {
      for (const { node, x, y } of moved) {
        node.pos[0] = x;
        node.pos[1] = y;
      }
      return { graph };
    },
  };
}

/**
 * Decides a grouping. The output node stays at the root, because it is the graph's binding to
 * its slot rather than a step in drawing the picture; everything else the cut allows may go.
 */
function decideCreateGroup(graph: Graph, edit: GenEdit & { op: 'createGroup' }): GenEditResult {
  const ref = edit.ref;
  if (ref !== undefined && !isGraphSlug(ref)) return refuse(badRef(ref));

  const plan = groupPlan(graph, edit.nodes);
  if (isRefusal(plan)) return refuse(plan.refusal);

  const output = plan.nodes.find((n) => genNodeSpec(n.def.typeName)?.slotProp !== undefined);
  if (output !== undefined) {
    return refuse(
      `the ${nameOf(output)} node fills a slot for the whole graph, so it stays at the root rather than inside a group`,
    );
  }

  const what =
    plan.nodes.length === 1
      ? `the ${nameOf(plan.nodes[0]!)} node`
      : plural(plan.nodes.length, 'node');
  return {
    ok   : true,
    note : ref === undefined ? `Groups ${what}.` : `Groups ${what} into '${ref}'.`,
    apply: () => {
      if (ref === undefined) throw new Error('a group is created under a ref, and none was given');
      const created = createGroup(graph, edit.nodes, ref);
      return { graph, node: created.node.id, definitions: [{ ref, def: created.def }] };
    },
  };
}

function decideUngroup(graph: Graph, edit: GenEdit & { op: 'ungroup' }): GenEditResult {
  const node = resolveNodeKey(graph, edit.node);
  if (node === undefined) return refuse(missing(edit.node));
  if (!(node instanceof GroupNode)) return refuse(`the ${nameOf(node)} node is not a group`);
  const refused = structuralRefusal(graph, node);
  if (refused !== undefined) return refuse(refused);
  if (node.definition === undefined) {
    return refuse(`group '${node.ref}' has not loaded, so there is nothing to inline`);
  }

  const inner = node.subgraph.nodes.filter((n) => !isProxy(n)).length;
  return {
    ok   : true,
    note : `Inlines the ${plural(inner, 'node')} of group '${node.ref}' where the instance stands.`,
    apply: () => {
      const done = ungroup(graph, node);
      if (isRefusal(done)) throw new Error(done.refusal);
      return { graph };
    },
  };
}

function decideAddGroup(graph: Graph, edit: GenEdit & { op: 'addGroup' }): GenEditResult {
  const refused = graph.structuralEditsRefused();
  if (refused !== undefined) return refuse(refused);
  if (!isGraphSlug(edit.ref)) return refuse(badRef(edit.ref));

  const host = definitionOfSubgraph(graph);
  if (host !== undefined && edit.def !== undefined && GroupNode.chainContains(edit.def, host)) {
    return refuse('a group cannot contain itself, directly or through another group');
  }

  return {
    ok   : true,
    note : `Adds an instance of group '${edit.ref}'.`,
    apply: () => {
      const node = new GroupNode();
      node.ref = edit.ref;
      place(graph, node, edit.pos);
      graph.add(node);
      if (edit.def !== undefined) {
        node.setDefinition(edit.ref, edit.def);
        node.syncToDefinition();
      }
      return { graph, node: node.id };
    },
  };
}

/** The definition this graph is the subgraph of, or the sentence refusing a definition edit. */
function definitionOf(graph: Graph): GroupDef | string {
  return (
    definitionOfSubgraph(graph) ??
    'this graph is not a group definition, so it has no boundary or forwarded rows to edit'
  );
}

/** Checks what a forwarded row would point at, answering the refusal when it points at nothing. */
function targetRefusal(
  def: GroupDef,
  kind: 'prop' | 'nodeUI',
  nodeId: GraphId,
  key: string | undefined,
): { node: Node } | string {
  const node = def.subgraph.nodeIdMap.get(nodeId);
  if (node === undefined) return `the group holds no node ${String(nodeId)}`;
  if (isProxy(node)) return "the group's own input and output nodes have nothing to expose";
  if (
    kind === 'prop' &&
    nodePropTarget(node, (key ?? '') as unknown as NodePropName) === undefined
  ) {
    return `the ${nameOf(node)} node has no property '${key ?? ''}'`;
  }
  return { node };
}

function decideExpose(graph: Graph, edit: GenEdit & { op: 'expose' }): GenEditResult {
  const def = definitionOf(graph);
  if (typeof def === 'string') return refuse(def);

  const target = targetRefusal(def, edit.kind, edit.node, edit.key);
  if (typeof target === 'string') return refuse(target);
  const key = edit.kind === 'prop' ? (edit.key ?? '') : '';
  if (
    def.exposed.some(
      (e) => e.kind === edit.kind && e.nodeId === edit.node && String(e.propKey) === key,
    )
  ) {
    return refuse('that is already exposed');
  }
  if (edit.at !== undefined && (edit.at < 0 || edit.at > def.exposed.length)) {
    return refuse(`there is no row ${edit.at} to insert at`);
  }

  const what =
    edit.kind === 'prop'
      ? `'${key}' of the ${nameOf(target.node)} node`
      : `the ${nameOf(target.node)} node's controls`;
  return {
    ok   : true,
    note : `Exposes ${what} on every instance of the group.`,
    apply: () => {
      const req = {
        kind  : edit.kind,
        nodeId: edit.node,
        ...(edit.key === undefined ? {} : { propKey: edit.key }),
        ...(edit.label === undefined ? {} : { label: edit.label }),
      };
      const done = exposeEntry(def, req, edit.at);
      if (isRefusal(done)) throw new Error(done.refusal);
      return { graph };
    },
  };
}

function decideUnexpose(graph: Graph, edit: GenEdit & { op: 'unexpose' }): GenEditResult {
  const def = definitionOf(graph);
  if (typeof def === 'string') return refuse(def);
  const entry = def.exposed[edit.index];
  if (entry === undefined) return refuse(noRow(edit.index));

  return {
    ok   : true,
    note : `Stops forwarding ${rowName(def, entry)} to the group's instances.`,
    apply: () => {
      const done = removeEntry(def, edit.index);
      if (isRefusal(done)) throw new Error(done.refusal);
      return { graph };
    },
  };
}

function decideReorder(graph: Graph, edit: GenEdit & { op: 'reorderExposed' }): GenEditResult {
  const def = definitionOf(graph);
  if (typeof def === 'string') return refuse(def);
  const entry = def.exposed[edit.from];
  if (entry === undefined) return refuse(noRow(edit.from));
  if (edit.to < 0 || edit.to >= def.exposed.length) return refuse(noRow(edit.to));

  return {
    ok   : true,
    note : `Moves ${rowName(def, entry)} to row ${edit.to + 1} of the group's controls.`,
    apply: () => {
      const done = reorderEntry(def, edit.from, edit.to);
      if (done !== undefined) throw new Error(done.refusal);
      return { graph };
    },
  };
}

function decideRepoint(graph: Graph, edit: GenEdit & { op: 'repointExposed' }): GenEditResult {
  const def = definitionOf(graph);
  if (typeof def === 'string') return refuse(def);
  const entry = def.exposed[edit.index];
  if (entry === undefined) return refuse(noRow(edit.index));

  const target = targetRefusal(def, entry.kind, edit.node, edit.key);
  if (typeof target === 'string') return refuse(target);

  const at =
    entry.kind === 'prop'
      ? `'${edit.key ?? ''}' of the ${nameOf(target.node)} node`
      : `the ${nameOf(target.node)} node`;
  return {
    ok   : true,
    note : `Points ${rowName(def, entry)} at ${at}.`,
    apply: () => {
      const done = repointEntry(def, edit.index, edit.node, edit.key);
      if (isRefusal(done)) throw new Error(done.refusal);
      return { graph };
    },
  };
}

function decideAddBoundary(graph: Graph, edit: GenEdit & { op: 'addBoundary' }): GenEditResult {
  const def = definitionOf(graph);
  if (typeof def === 'string') return refuse(def);
  if (edit.key === '') return refuse('a boundary socket needs a name');
  if (getSocketClass(edit.type) === undefined) {
    return refuse(`there is no socket type '${edit.type}' registered here`);
  }
  const side = edit.dir === 'in' ? def.inputs : def.outputs;
  if (edit.key in side) {
    return refuse(`the group already has an ${sideName(edit.dir)} named '${edit.key}'`);
  }

  return {
    ok   : true,
    note : `Adds a '${edit.type}' ${sideName(edit.dir)} named '${edit.key}' to the group.`,
    apply: () => {
      const done = addBoundary(def, edit.dir, edit.key, edit.type);
      if (isRefusal(done)) throw new Error(done.refusal);
      return { graph };
    },
  };
}

function decideRemoveBoundary(
  graph: Graph,
  edit: GenEdit & { op: 'removeBoundary' },
): GenEditResult {
  const def = definitionOf(graph);
  if (typeof def === 'string') return refuse(def);
  const side = edit.dir === 'in' ? def.inputs : def.outputs;
  if (!(edit.key in side)) {
    return refuse(`the group has no ${sideName(edit.dir)} named '${edit.key}'`);
  }

  const proxy =
    edit.dir === 'in' ? def.inputNode().outputs[edit.key] : def.outputNode().inputs[edit.key];
  const links = proxy?.edges.length ?? 0;
  const severed = links === 0 ? '' : ` and severs the ${plural(links, 'link')} into it`;
  return {
    ok   : true,
    note: `Removes the group's ${sideName(edit.dir)} '${edit.key}'${severed}; every instance loses the socket.`,
    apply: () => {
      const done = removeBoundary(def, edit.dir, edit.key);
      if (isRefusal(done)) throw new Error(done.refusal);
      return { graph };
    },
  };
}

function decideApply(graph: Graph, edit: GenEdit & { op: 'apply' }): GenEditResult {
  const refused = graph.structuralEditsRefused();
  if (refused !== undefined) return refuse(refused);

  const result = applyGraphDSL(graph, edit.description, edit.groups);
  const first = result.diagnostics[0];
  if (first !== undefined) {
    const rest = result.diagnostics.length - 1;
    const more = rest === 0 ? '' : ` (and ${plural(rest, 'other problem')})`;
    return refuse(
      `the description cannot be applied: ${first.message}${more}`,
      result.diagnostics.map((d) => d.message),
    );
  }

  const counts = [
    `keeps ${plural(result.kept.length, 'node')}`,
    `adds ${result.added.length}`,
    `removes ${result.removed.length}`,
  ].join(', ');

  return {
    ok   : true,
    note : `Replaces the graph: ${counts}.`,
    apply: () => ({ graph: result.graph }),
  };
}

export type GenPropRead = { ok: true; value: GenPropValue } | { ok: false; reason: string };

/**
 * Reads a prop value that arrived as text, which is what a command form and a tool call both
 * carry. The node's own property decides how the text is read, so `true` reaches a boolean prop
 * as a boolean and stays four characters on a string prop.
 */
export function readGenPropValue(
  graph: Graph,
  node: GraphId,
  key: string,
  text: string,
): GenPropRead {
  const target = resolveNodeKey(graph, node);
  if (target === undefined) return { ok: false, reason: missing(node) };

  const prop = resolveNodeProp(target, key);
  if (prop === undefined) {
    return {
      ok    : false,
      reason: `node type '${target.def.typeName}' declares no prop or editable input '${key}'`,
    };
  }

  const said = text.trim();
  switch (valueKind(prop)) {
    case 'boolean': {
      if (['true', 'yes', '1', 'on'].includes(said.toLowerCase())) return { ok: true, value: true };
      if (['false', 'no', '0', 'off'].includes(said.toLowerCase())) {
        return { ok: true, value: false };
      }
      return { ok: false, reason: `'${key}' on a ${nameOf(target)} node takes true or false` };
    }
    case 'number': {
      const value = Number(said);
      if (said === '' || Number.isNaN(value)) {
        return { ok: false, reason: `'${key}' on a ${nameOf(target)} node takes a number` };
      }
      return { ok: true, value };
    }
    default:
      return { ok: true, value: text };
  }
}

/** The JavaScript type a property takes, or undefined for one this path does not edit. */
function valueKind(prop: ToolProperty): 'string' | 'number' | 'boolean' | undefined {
  switch (prop.type) {
    case PropTypes.STRING:
      return 'string';
    case PropTypes.BOOL:
      return 'boolean';
    case PropTypes.INT:
    case PropTypes.FLOAT:
      return 'number';
    default:
      return undefined;
  }
}

/** Whether `target` sits upstream of `from`, which is what makes a new link a cycle. */
function reachesUpstream(from: Node, target: Node): boolean {
  const seen = new Set<Node>();
  const stack: Node[] = [from];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);

    for (const sock of Object.values(node.inputs)) {
      for (const src of sock.edges) {
        const owner = src.owningNode as Node | undefined;
        if (owner !== undefined) stack.push(owner);
      }
    }
  }

  return false;
}

/** path.ux's refusal where the node's own graph takes value edits only, else undefined. */
function structuralRefusal(graph: Graph, node: Node): string | undefined {
  return (node.graph ?? graph).structuralEditsRefused();
}

function isProxy(node: Node): boolean {
  return node instanceof GroupInputNode || node instanceof GroupOutputNode;
}

function linkCount(node: Node): number {
  const sockets: NodeSocketBase[] = [...Object.values(node.inputs), ...Object.values(node.outputs)];
  return sockets.reduce((total, sock) => total + sock.edges.length, 0);
}

function nameOf(node: Node): string {
  const named = typeof node.def.uiName === 'function' ? node.def.uiName(node) : node.def.uiName;
  return node.label ?? named ?? node.def.typeName;
}

/** A forwarded row as the note names it: its label, else what it points at. */
function rowName(def: GroupDef, entry: ExposedEntry): string {
  if (entry.label !== undefined && entry.label !== '') return `the '${entry.label}' row`;
  const node = def.subgraph.nodeIdMap.get(entry.nodeId);
  const owner = node === undefined ? `node ${String(entry.nodeId)}` : `the ${nameOf(node)} node`;
  return entry.kind === 'prop' ? `'${String(entry.propKey)}' of ${owner}` : `${owner}'s controls`;
}

function sideName(dir: SocketDir): string {
  return dir === 'in' ? 'input' : 'output';
}

function badRef(ref: string): string {
  return `'${ref}' is not a group name; use letters, digits and dashes`;
}

function noRow(index: number): string {
  return `the group has no forwarded row ${index}`;
}

function missing(id: GraphId): string {
  return `this graph holds no node ${String(id)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
