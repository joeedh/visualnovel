/**
 * What the Gen Graph pane turns a gesture into: the edit `decideGenEdit` judges, and the
 * `gengraph.*` command that carries it. Six of path.ux's gesture kinds have no command here and
 * are refused by name, so a gesture the application cannot write never reads as accepted.
 *
 * The pane itself can only be checked live over CDP, so the mapping lives here where the
 * node-only jest project runs it. `pathux` is imported type-only because jest resolves
 * `pathux-graph` and `pathux-toolprop` and not the widget barrel.
 */
import { activeOutputs, genNodeSpec, type GenEdit, type Graph } from '@vn/gengraph';
import type { GraphEdit } from 'pathux';

/** One `gengraph.*` invocation, in the shape `exec` takes. */
export interface GenCommand {
  id: string;
  props: Record<string, string | number | boolean>;
}

export type GenEditFor = { ok: true; edit: GenEdit } | { ok: false; reason: string };

/**
 * Why each gesture path.ux offers has no command here. Group exposure is refused because a
 * generation graph is one flat graph, and the other two are refused because a node's identity is
 * what its journal is keyed by, so neither copying nor retyping a node is an edit this
 * application can make.
 */
const UNSUPPORTED: Record<string, string> = {
  duplicateNode: 'copying a node is not offered here; add another of the same type instead',
  replaceNode: "changing a node's type is not offered here; remove it and add the type you want",
  exposeEntry: 'a generation graph is one flat graph, so it has no group properties to expose',
  reorderEntry: 'a generation graph is one flat graph, so it has no group properties to reorder',
  repointEntry: 'a generation graph is one flat graph, so it has no group properties to repoint',
  removeEntry: 'a generation graph is one flat graph, so it has no group properties to remove',
};

/**
 * The slots more than one active output claims. `bindSlots` leaves such a slot bound to no graph,
 * and a new output node arrives active, so the pane both reports the slot and keeps offering
 * `gengraph.setActiveOutput` on an output that is already active.
 */
export function contestedSlots(graph: Graph): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();

  for (const output of activeOutputs(graph)) {
    if (output.slot === '') continue;
    if (seen.has(output.slot)) twice.add(output.slot);
    seen.add(output.slot);
  }

  return [...twice];
}

/**
 * True where the graph carries output nodes and none of them is active. Standing the last one
 * down is a legal edit rather than a refused one, so the pane reports the state the same way it
 * reports a contested slot. A graph with no output node at all is half-authored and says nothing.
 */
export function noActiveOutput(graph: Graph): boolean {
  const outputs = graph.nodes.filter(
    (node) => genNodeSpec(node.def.typeName)?.slotProp !== undefined,
  );

  return outputs.length > 0 && activeOutputs(graph).length === 0;
}

/** Reads a gesture as the edit this application decides, refusing the kinds it cannot write. */
export function genEditFor(edit: GraphEdit): GenEditFor {
  switch (edit.kind) {
    case 'moveNode':
      return { ok: true, edit: { op: 'moveNodes', moves: [{ node: edit.nodeId, ...at(edit) }] } };
    case 'moveNodes':
    case 'arrange':
      return {
        ok: true,
        edit: {
          op: 'moveNodes',
          moves: edit.moves.map((move) => ({ node: move.nodeId, ...at(move) })),
        },
      };
    case 'addNode':
      return { ok: true, edit: { op: 'addNode', type: edit.nodeType, pos: [edit.x, edit.y] } };
    case 'deleteNode':
      return { ok: true, edit: { op: 'removeNode', node: edit.nodeId } };
    case 'connect':
      return {
        ok: true,
        edit: {
          op: 'link',
          from: edit.srcNode,
          fromSocket: edit.srcSocket,
          to: edit.dstNode,
          toSocket: edit.dstSocket,
        },
      };
    case 'disconnect':
      return {
        ok: true,
        edit: {
          op: 'unlink',
          to: edit.dstNode,
          toSocket: edit.dstSocket,
          from: edit.srcNode,
          fromSocket: edit.srcSocket,
        },
      };
    default:
      return { ok: false, reason: UNSUPPORTED[edit.kind] ?? `'${edit.kind}' is not offered here` };
  }
}

const at = (move: { x: number; y: number }): { x: number; y: number } => ({ x: move.x, y: move.y });

/**
 * The command one edit is written through. Three props carry something richer than a string
 * because `@vn/commands` has no JSON or list prop kind: a move list and a whole-graph description
 * are JSON text, and a property value is text the node's own property reads.
 */
export function commandFor(slug: string, edit: GenEdit): GenCommand {
  switch (edit.op) {
    case 'moveNodes':
      return {
        id: 'gengraph.moveNodes',
        props: {
          slug,
          moves: JSON.stringify(
            edit.moves.map((move) => ({ node: String(move.node), x: move.x, y: move.y })),
          ),
        },
      };
    case 'addNode': {
      const [x, y] = edit.pos ?? [0, 0];
      return { id: 'gengraph.addNode', props: { slug, type: edit.type, x, y } };
    }
    case 'removeNode':
      return { id: 'gengraph.removeNode', props: { slug, node: String(edit.node) } };
    case 'link':
      return {
        id: 'gengraph.link',
        props: {
          slug,
          from: String(edit.from),
          fromSocket: edit.fromSocket,
          to: String(edit.to),
          toSocket: edit.toSocket,
        },
      };
    case 'unlink':
      return {
        id: 'gengraph.unlink',
        props: {
          slug,
          to: String(edit.to),
          toSocket: edit.toSocket,
          from: edit.from === undefined ? '' : String(edit.from),
          fromSocket: edit.fromSocket ?? '',
        },
      };
    case 'setProp':
      return {
        id: 'gengraph.setProp',
        props: { slug, node: String(edit.node), key: edit.key, value: String(edit.value) },
      };
    case 'setActiveOutput':
      return { id: 'gengraph.setActiveOutput', props: { slug, node: String(edit.node) } };
    case 'apply':
      return {
        id: 'gengraph.apply',
        props: { slug, description: JSON.stringify(edit.description) },
      };
  }
}
