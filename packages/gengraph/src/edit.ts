/**
 * The rules one edit to a generation graph must pass, decided before anything is changed.
 * A host asks `decideGenEdit` what an edit would do, shows or returns the refusal, and calls
 * the decision's `apply` only once it means to write. The desktop commands and the authoring
 * agent's graph tool both go through here, so a refusal reads the same in both.
 */
import { parseSlot } from '@vn/artgen/slotaddr';
import { nodePropTarget } from 'pathux-graph';
import type { Graph, GraphId, Node, NodeSocketBase } from 'pathux-graph';
import { PropTypes } from 'pathux-toolprop';
import type { ToolProperty } from 'pathux-toolprop';

import { applyGraphDSL, placeNewNodes } from './dsl.js';
import { genNodeSpec, genNodeTypes } from './registry.js';

/** A value an authored prop can hold. Anything richer is edited through the whole-DSL path. */
export type GenPropValue = string | number | boolean;

export type GenEdit =
  | { op: 'addNode'; type: string; pos?: readonly [number, number] }
  | { op: 'removeNode'; node: GraphId }
  | { op: 'link'; from: GraphId; fromSocket: string; to: GraphId; toSocket: string }
  /** Severs one named link, or every link into `toSocket` when no source is named. */
  | { op: 'unlink'; to: GraphId; toSocket: string; from?: GraphId; fromSocket?: string }
  | { op: 'setProp'; node: GraphId; key: string; value: GenPropValue }
  | { op: 'setActiveOutput'; node: GraphId }
  /** Where nodes now sit. One drag moves every node it caught, so a move takes a list. */
  | { op: 'moveNodes'; moves: readonly GenNodeMove[] }
  | { op: 'apply'; description: unknown };

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
    case 'apply':
      return decideApply(graph, edit);
  }
}

function decideAdd(graph: Graph, edit: GenEdit & { op: 'addNode' }): GenEditResult {
  const cls = genNodeTypes().get(edit.type);
  if (cls === undefined) {
    return refuse(
      `there is no node type '${edit.type}' registered here; the plugin providing it may not be installed`,
    );
  }

  const declared = cls.graphDef().uiName;
  const uiName = typeof declared === 'string' ? declared : edit.type;
  return {
    ok: true,
    note: `Adds a ${uiName} node.`,
    apply: () => {
      const node = new cls();
      if (edit.pos === undefined) {
        placeNewNodes(graph.nodes, [node]);
      } else {
        node.pos[0] = edit.pos[0];
        node.pos[1] = edit.pos[1];
      }
      graph.add(node);
      return { graph, node: node.id };
    },
  };
}

function decideRemove(graph: Graph, edit: GenEdit & { op: 'removeNode' }): GenEditResult {
  const node = graph.nodeIdMap.get(edit.node);
  if (node === undefined) {
    return refuse(missing(edit.node));
  }

  const links = linkCount(node);
  const carried = links === 0 ? '' : ` and the ${plural(links, 'link')} it carries`;
  return {
    ok: true,
    note: `Removes the ${nameOf(node)} node${carried}.`,
    apply: () => {
      graph.remove(node);
      return { graph };
    },
  };
}

function decideLink(graph: Graph, edit: GenEdit & { op: 'link' }): GenEditResult {
  const from = graph.nodeIdMap.get(edit.from);
  const to = graph.nodeIdMap.get(edit.to);
  if (from === undefined) return refuse(missing(edit.from));
  if (to === undefined) return refuse(missing(edit.to));

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
  const to = graph.nodeIdMap.get(edit.to);
  if (to === undefined) return refuse(missing(edit.to));

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
      ok: true,
      note: `Severs the ${plural(edges.length, 'link')} into '${edit.toSocket}' on the ${nameOf(to)} node.`,
      apply: () => {
        for (const src of edges) graph.disconnect(src, dst);
        return { graph };
      },
    };
  }

  const from = graph.nodeIdMap.get(edit.from);
  if (from === undefined) return refuse(missing(edit.from));

  const src = edit.fromSocket === undefined ? undefined : from.outputs[edit.fromSocket];
  const named = src === undefined ? dst.edges.find((e) => e.owningNode === from) : src;
  if (named === undefined || !dst.edges.includes(named)) {
    return refuse(
      `the ${nameOf(from)} node does not feed '${edit.toSocket}' on the ${nameOf(to)} node`,
    );
  }

  return {
    ok: true,
    note: `Severs the link from the ${nameOf(from)} node into '${edit.toSocket}'.`,
    apply: () => {
      graph.disconnect(named, dst);
      return { graph };
    },
  };
}

function decideSetProp(graph: Graph, edit: GenEdit & { op: 'setProp' }): GenEditResult {
  const node = graph.nodeIdMap.get(edit.node);
  if (node === undefined) return refuse(missing(edit.node));

  const prop = nodePropTarget(node, edit.key);
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
    ok: true,
    note: `Sets '${edit.key}' on the ${nameOf(node)} node to ${JSON.stringify(edit.value)}.`,
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
  const node = graph.nodeIdMap.get(edit.node);
  if (node === undefined) return refuse(missing(edit.node));

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
    ok: true,
    note: `Makes this the output run for ${named}${stood}.`,
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
 */
function decideMove(graph: Graph, edit: GenEdit & { op: 'moveNodes' }): GenEditResult {
  if (edit.moves.length === 0) return refuse('this move names no node');

  const problems: string[] = [];
  const moved: { node: Node; x: number; y: number }[] = [];

  for (const move of edit.moves) {
    const node = graph.nodeIdMap.get(move.node);
    if (node === undefined) {
      problems.push(missing(move.node));
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
    ok: true,
    note: `Moves ${what}.`,
    apply: () => {
      for (const { node, x, y } of moved) {
        node.pos[0] = x;
        node.pos[1] = y;
      }
      return { graph };
    },
  };
}

function decideApply(graph: Graph, edit: GenEdit & { op: 'apply' }): GenEditResult {
  const result = applyGraphDSL(graph, edit.description);
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
    ok: true,
    note: `Replaces the graph: ${counts}.`,
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
  const target = graph.nodeIdMap.get(node);
  if (target === undefined) return { ok: false, reason: missing(node) };

  const prop = nodePropTarget(target, key);
  if (prop === undefined) {
    return {
      ok: false,
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

function linkCount(node: Node): number {
  const sockets: NodeSocketBase[] = [...Object.values(node.inputs), ...Object.values(node.outputs)];
  return sockets.reduce((total, sock) => total + sock.edges.length, 0);
}

function nameOf(node: Node): string {
  const named = typeof node.def.uiName === 'function' ? node.def.uiName(node) : node.def.uiName;
  return node.label ?? named ?? node.def.typeName;
}

function missing(id: GraphId): string {
  return `this graph holds no node ${String(id)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
