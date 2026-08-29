/**
 * What the Gen Graph pane turns a gesture into: the edit `decideGenEdit` judges, and the
 * `gengraph.*` command that carries it. Six of path.ux's gesture kinds have no command here and
 * are refused by name, so a gesture the application cannot write never reads as accepted.
 * `DocSync` and `shouldReload` are the other half of the pane's rules: they track the document
 * versions its writes produce, so an echo of its own write does not make it re-read the file.
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
 * generation graph is one flat graph, and retyping is refused because a node's identity is what
 * its journal is keyed by, and swapping the type in place would leave the journal describing a
 * node that no longer exists.
 */
const UNSUPPORTED: Record<string, string> = {
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
 * The one slot this graph draws, or nothing where it draws none it can be held to. A graph with
 * two active outputs is left out along with a graph with none: `bindSlots` binds neither, so
 * naming one of the two would send the author to a picture this graph did not draw.
 */
export function drawnSlot(graph: Graph): string {
  const named = activeOutputs(graph).filter((output) => output.slot !== '');
  return named.length === 1 ? named[0]!.slot : '';
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

/** What a pane knows about the versions of the one document it is showing. */
export interface DocSync {
  /** Writes this pane has sent and not yet had answered. */
  inflight: number;
  /** The highest version this pane's own writes produced. */
  mine: number;
  /** The highest version anyone has reported for this document. */
  latest: number;
  /**
   * Set when a write refused, which is the one case where the pane holds an edit the file never
   * took: it applies an edit to its own copy before sending it.
   */
  stale: boolean;
}

/** A pane that has shown nothing and written nothing. */
export function newDocSync(): DocSync {
  return { inflight: 0, mine: 0, latest: 0, stale: false };
}

/**
 * Whether an echo naming `incoming` should make the pane re-read its document.
 *
 * Outstanding local writes settle it before anything else is consulted: a pane applies an edit to
 * its own copy before sending it, so while anything is unanswered its copy is ahead of whatever
 * main can report and re-reading would show the author their own edit being undone. The write
 * that settles the last of them asks again, which is where both a refusal and a change somebody
 * else made during that window are picked up.
 *
 * `undefined` is a signal that named no version — an undo or a redo, which restores files no
 * command declared. There is nothing to compare, so it is taken at its word.
 */
export function shouldReload(sync: DocSync, incoming: number | undefined): boolean {
  if (sync.inflight > 0) return false;
  if (sync.stale) return true;
  if (incoming === undefined) return true;
  return incoming > sync.mine;
}

/** Translates a UI gesture into a graph edit, refusing edit kinds this pane cannot write. */
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
    case 'duplicateNode':
      return {
        ok: true,
        edit: { op: 'duplicateNode', node: edit.nodeId, pos: [edit.x, edit.y] },
      };
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
    case 'duplicateNode': {
      const [x, y] = edit.pos ?? [0, 0];
      return { id: 'gengraph.duplicateNode', props: { slug, node: String(edit.node), x, y } };
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
