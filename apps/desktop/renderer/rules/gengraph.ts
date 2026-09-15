/**
 * What the Gen Graph pane turns a gesture into: the edit `decideGenEdit` judges, and the
 * `gengraph.*` command that carries it. One of path.ux's gesture kinds has no command here and is
 * refused by name, so a gesture the application cannot write never reads as accepted. An edit is
 * addressed by the level the view is on: a definition level names its `group`, and a node inside
 * an instance is named by the key main resolves, `<instance>/<id>`.
 *
 * `DocSync` and `shouldReload` are the other half of the pane's rules: they track the document
 * versions its writes produce, so an echo of its own write does not make it re-read the file.
 *
 * The pane itself can only be checked live over CDP, so the mapping lives here where the
 * node-only jest project runs it. `pathux` is imported type-only because jest resolves
 * `pathux-graph` and `pathux-toolprop` and not the widget barrel.
 */
import {
  GroupNode,
  activeOutputs,
  genNodeSpec,
  type GenEdit,
  type Graph,
  type GraphId,
} from '@vn/gengraph';
import type { DescentEntry, GraphEdit } from 'pathux';

import { graphDocPath, graphGroupPath } from '../../src/shared/writes.js';
import { refuse, type Control, type Offer } from './anchors.js';
import { openMenu, publish, view } from './effects.js';
import { refreshModelsAction } from './models.js';
import { shortcutOf } from './shortcuts.js';

/** One `gengraph.*` invocation, in the shape `exec` takes. */
export interface GenCommand {
  id: string;
  props: Record<string, string | number | boolean>;
}

export type GenEditFor = { ok: true; edit: GenEdit } | { ok: false; reason: string };

/**
 * Where an edit made at one level of the view is written.
 *
 * `group` is the definition the level is inside, or empty for the graph itself. `prefix` is the
 * instance ids between that document's own graph and the level on screen, so a node on screen is
 * named to main as `prefix.join('/') + '/' + id`; it is empty at the root and at a definition
 * level, where the ids are the document's own.
 */
export interface EditTarget {
  slug: string;
  group: string;
  prefix: string[];
}

/**
 * Why the one gesture path.ux offers with no command here has none: a node's identity is what
 * its journal is keyed by, and swapping the type in place would leave the journal describing a
 * node that no longer exists.
 */
const UNSUPPORTED: Record<string, string> = {
  replaceNode: "changing a node's type is not offered here; remove it and add the type you want",
};

/**
 * The target an edit at the end of `descent` writes to. Each step is looked up in the graph the
 * previous one reached, the way the view walks its own level; a step that no longer resolves
 * answers nothing, and the view is on no level either.
 */
export function targetFor(
  slug: string,
  root: Graph,
  descent: readonly DescentEntry[],
): EditTarget | undefined {
  let graph = root;
  let group = '';
  let prefix: string[] = [];

  for (const step of descent) {
    const node = graph.nodeIdMap.get(step.nodeId);
    if (!(node instanceof GroupNode)) return undefined;
    if (step.into === 'definition') {
      if (node.definition === undefined) return undefined;
      group = node.ref;
      prefix = [];
      graph = node.definition.subgraph;
    } else {
      prefix = [...prefix, String(node.id)];
      graph = node.subgraph;
    }
  }

  return { slug, group, prefix };
}

/** How main is told which node an edit means: the level's own id, under its instance prefix. */
export function keyOf(target: EditTarget, id: GraphId): string {
  return [...target.prefix, String(id)].join('/');
}

/** The document a target's edits write, which is what its sync is keyed by. */
export function docPathFor(target: EditTarget): string {
  return target.group === '' ? graphDocPath(target.slug) : graphGroupPath(target.group);
}

/**
 * The edits the pane cannot apply to its own copy: main allocates a group's ref, and an
 * instance is unresolved until a definition is loaded. Each is sent first and shown when the
 * acknowledgement reloads the graph.
 */
export function reloadsOnAck(op: GenEdit['op']): boolean {
  return op === 'createGroup' || op === 'ungroup' || op === 'addGroup';
}

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

/** What a pane knows about the versions of one document it is showing or writing. */
export interface DocSync {
  /** Writes this pane has sent and not yet had answered. */
  inflight: number;
  /** The highest version this pane's own writes produced. */
  mine: number;
  /** The highest version anyone has reported for this document. */
  latest: number;
  /**
   * Set when a write refused, which is the one case where the pane holds an edit the file never
   * took: it applies an edit to its own copy before sending it. Set too for an edit the pane
   * cannot apply itself, so the acknowledgement is what puts it on screen.
   */
  stale: boolean;
}

/** A document the pane has shown nothing of and written nothing to. */
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

/** Translates a UI gesture into a graph edit, refusing the edit kind this pane cannot write. */
export function genEditFor(edit: GraphEdit): GenEditFor {
  switch (edit.kind) {
    case 'moveNode':
      return { ok: true, edit: { op: 'moveNodes', moves: [{ node: edit.nodeId, ...at(edit) }] } };
    case 'moveNodes':
    case 'arrange':
      return {
        ok  : true,
        edit: {
          op   : 'moveNodes',
          moves: edit.moves.map((move) => ({ node: move.nodeId, ...at(move) })),
        },
      };
    case 'addNode':
      // A group instance is added by naming its definition; the type alone says nothing.
      if (edit.nodeType === 'GroupNode') {
        return {
          ok  : true,
          edit: { op: 'addGroup', ref: edit.ref ?? '', pos: [edit.x, edit.y] },
        };
      }
      return { ok: true, edit: { op: 'addNode', type: edit.nodeType, pos: [edit.x, edit.y] } };
    case 'duplicateNode':
      return {
        ok  : true,
        edit: { op: 'duplicateNode', node: edit.nodeId, pos: [edit.x, edit.y] },
      };
    case 'deleteNode':
      return { ok: true, edit: { op: 'removeNode', node: edit.nodeId } };
    case 'connect':
      return {
        ok  : true,
        edit: {
          op        : 'link',
          from      : edit.srcNode,
          fromSocket: edit.srcSocket,
          to        : edit.dstNode,
          toSocket  : edit.dstSocket,
        },
      };
    case 'disconnect':
      return {
        ok  : true,
        edit: {
          op        : 'unlink',
          to        : edit.dstNode,
          toSocket  : edit.dstSocket,
          from      : edit.srcNode,
          fromSocket: edit.srcSocket,
        },
      };
    case 'createGroup':
      return {
        ok  : true,
        edit: {
          op   : 'createGroup',
          nodes: edit.nodeIds,
          ...(edit.ref === undefined || edit.ref === '' ? {} : { ref: edit.ref }),
        },
      };
    case 'ungroup':
      return { ok: true, edit: { op: 'ungroup', node: edit.nodeId } };
    case 'exposeEntry':
      return {
        ok  : true,
        edit: {
          op  : 'expose',
          kind: edit.entry.kind,
          node: edit.entry.nodeId,
          ...(edit.entry.propKey === undefined ? {} : { key: edit.entry.propKey }),
          ...(edit.entry.label === undefined ? {} : { label: edit.entry.label }),
          ...(edit.at === undefined ? {} : { at: edit.at }),
        },
      };
    case 'reorderEntry':
      return { ok: true, edit: { op: 'reorderExposed', from: edit.from, to: edit.to } };
    case 'repointEntry':
      return {
        ok  : true,
        edit: {
          op   : 'repointExposed',
          index: edit.index,
          node : edit.nodeId,
          key  : edit.propKey as unknown as string,
        },
      };
    case 'removeEntry':
      return { ok: true, edit: { op: 'unexpose', index: edit.index } };
    case 'addBoundary':
      return {
        ok  : true,
        edit: { op: 'addBoundary', dir: edit.dir, key: edit.key, type: edit.socketType },
      };
    case 'removeBoundary':
      return { ok: true, edit: { op: 'removeBoundary', dir: edit.dir, key: edit.key } };
    default:
      return { ok: false, reason: UNSUPPORTED[edit.kind] ?? `'${edit.kind}' is not offered here` };
  }
}

const at = (move: { x: number; y: number }): { x: number; y: number } => ({ x: move.x, y: move.y });

/**
 * The command one edit is written through. Three props carry something richer than a string
 * because `@vn/commands` has no JSON or list prop kind: a move list and a whole-graph description
 * are JSON text, and a property value is text the node's own property reads.
 *
 * A graph edit carries `group` only at a definition level, since the command's default is the
 * graph itself; a definition edit carries it always, because it has no other subject.
 */
export function commandFor(target: EditTarget, edit: GenEdit): GenCommand {
  const { slug, group } = target;
  const inGroup: Record<string, string> = group === '' ? {} : { group };
  const key = (id: GraphId): string => keyOf(target, id);

  switch (edit.op) {
    case 'moveNodes':
      return {
        id   : 'gengraph.moveNodes',
        props: {
          slug,
          moves: JSON.stringify(
            edit.moves.map((move) => ({ node: key(move.node), x: move.x, y: move.y })),
          ),
          ...inGroup,
        },
      };
    case 'addNode': {
      const [x, y] = edit.pos ?? [0, 0];
      return { id: 'gengraph.addNode', props: { slug, type: edit.type, x, y, ...inGroup } };
    }
    case 'duplicateNode': {
      const [x, y] = edit.pos ?? [0, 0];
      return {
        id   : 'gengraph.duplicateNode',
        props: { slug, node: key(edit.node), x, y, ...inGroup },
      };
    }
    case 'removeNode':
      return { id: 'gengraph.removeNode', props: { slug, node: key(edit.node), ...inGroup } };
    case 'link':
      return {
        id   : 'gengraph.link',
        props: {
          slug,
          from      : key(edit.from),
          fromSocket: edit.fromSocket,
          to        : key(edit.to),
          toSocket  : edit.toSocket,
          ...inGroup,
        },
      };
    case 'unlink':
      return {
        id   : 'gengraph.unlink',
        props: {
          slug,
          to        : key(edit.to),
          toSocket  : edit.toSocket,
          from      : edit.from === undefined ? '' : key(edit.from),
          fromSocket: edit.fromSocket ?? '',
          ...inGroup,
        },
      };
    case 'setProp':
      return {
        id   : 'gengraph.setProp',
        props: { slug, node: key(edit.node), key: edit.key, value: String(edit.value), ...inGroup },
      };
    case 'setActiveOutput':
      return { id: 'gengraph.setActiveOutput', props: { slug, node: String(edit.node) } };
    case 'apply':
      return {
        id   : 'gengraph.apply',
        props: { slug, description: JSON.stringify(edit.description) },
      };
    case 'createGroup':
      return {
        id   : 'gengraph.createGroup',
        props: { slug, nodes: edit.nodes.map(key).join(','), name: edit.ref ?? '', ...inGroup },
      };
    case 'ungroup':
      return { id: 'gengraph.ungroup', props: { slug, node: key(edit.node), ...inGroup } };
    case 'addGroup': {
      const [x, y] = edit.pos ?? [0, 0];
      return { id: 'gengraph.addGroup', props: { slug, ref: edit.ref, x, y, ...inGroup } };
    }
    case 'expose':
      return {
        id   : 'gengraph.expose',
        props: { group, node: key(edit.node), key: edit.key ?? '', label: edit.label ?? '' },
      };
    case 'unexpose':
      return { id: 'gengraph.unexpose', props: { group, index: edit.index } };
    case 'reorderExposed':
      return { id: 'gengraph.reorderExposed', props: { group, from: edit.from, to: edit.to } };
    case 'repointExposed':
      return {
        id   : 'gengraph.repointExposed',
        props: { group, index: edit.index, node: key(edit.node), key: edit.key ?? '' },
      };
    case 'addBoundary':
      return {
        id   : 'gengraph.addBoundary',
        props: { group, dir: edit.dir, key: edit.key, type: edit.type },
      };
    case 'removeBoundary':
      return { id: 'gengraph.removeBoundary', props: { group, dir: edit.dir, key: edit.key } };
  }
}

/** What the Gen Graph pane reads when it draws its bar. */
export interface GroupState {
  selected: GraphId[];
  /** The one slot this graph draws, which the Asset button shows; none or `''` refuses it. */
  slot?: string;
  /** The group instances among the selection, by id. */
  groups: GraphId[];
  /**
   * How the pane weighed each button's edit against the live graph, where it had one to weigh.
   * Delete and Duplicate act on every selected node in turn; the first is what is weighed.
   */
  weighed: {
    delete?: GenEditFor;
    duplicate?: GenEditFor;
    group?: GenEditFor;
    ungroup?: GenEditFor;
  };
  /** Where an edit at the level on screen is written; none when the level no longer resolves. */
  target?: EditTarget;
  /** The day the cached OpenRouter listing the node pickers draw was fetched; absent with none. */
  catalogAsOf?: string;
}

export const DELETE_WHAT = 'Remove the selected nodes and sever the selected links';

export const DUPLICATE_WHAT =
  'Add a copy of each selected node, carrying over the values it authored';

export const GROUP_WHAT =
  'Move the selected nodes into a new group, and leave an instance of it in their place ' +
  `(${shortcutOf({ id: 'gengraph.createGroup', props: {} })})`;

export const UNGROUP_WHAT =
  'Put a copy of each selected group’s nodes where the instance stands, values included ' +
  `(${shortcutOf({ id: 'gengraph.ungroup', props: {} })})`;

/** Said where the view's level no longer resolves, which undo and delete can bring about. */
export const NO_LEVEL = 'this level of the graph is no longer there; go back up';

/** The invocation a weighed gesture would send, or why it is refused: the weighing first, then the level. */
function judged(
  control: Control,
  weighed: GenEditFor | undefined,
  target: EditTarget | undefined,
): Offer {
  if (weighed === undefined || !weighed.ok) {
    return { ...refuse(weighed?.reason ?? NO_LEVEL), ...control };
  }
  if (target === undefined) return { ...refuse(NO_LEVEL), ...control };
  return { ok: true, ...commandFor(target, weighed.edit), ...control };
}

/** Remove the selection, refused first with nothing selected. */
export function deleteAction(
  selected: GraphId[],
  weighed: GenEditFor | undefined,
  target: EditTarget | undefined,
): Offer {
  const control = { id: 'gengraph.removeNode', label: 'Delete', tooltip: DELETE_WHAT };
  if (selected.length === 0) return { ...refuse('Select the nodes to delete first.'), ...control };
  return judged(control, weighed, target);
}

/** Copy the selection, refused first with nothing selected. */
export function duplicateAction(
  selected: GraphId[],
  weighed: GenEditFor | undefined,
  target: EditTarget | undefined,
): Offer {
  const control = { id: 'gengraph.duplicateNode', label: 'Duplicate', tooltip: DUPLICATE_WHAT };
  if (selected.length === 0) {
    return { ...refuse('Select the nodes to duplicate first.'), ...control };
  }
  return judged(control, weighed, target);
}

/** Group the selection, refused first with nothing selected. */
export function groupAction(
  selected: GraphId[],
  weighed: GenEditFor | undefined,
  target: EditTarget | undefined,
): Offer {
  const control = { id: 'gengraph.createGroup', label: 'Group', tooltip: GROUP_WHAT };
  if (selected.length === 0) return { ...refuse('Select the nodes to group first.'), ...control };
  return judged(control, weighed, target);
}

/** Ungroup the first selected group instance, refused first with none selected. */
export function ungroupAction(
  groups: GraphId[],
  weighed: GenEditFor | undefined,
  target: EditTarget | undefined,
): Offer {
  const control = { id: 'gengraph.ungroup', label: 'Ungroup', tooltip: UNGROUP_WHAT };
  if (groups.length === 0) return { ...refuse('Select a group instance to ungroup.'), ...control };
  return judged(control, weighed, target);
}

/** Add…, which drops down path.ux's menu of node types; a pick adds one at a fixed spot. */
export function addAction(): Offer {
  return {
    ok: true,
    ...openMenu('nodes'),
    label  : 'Add…',
    tooltip: 'Add a node to this graph',
  };
}

/** Arrange, a relayout of the whole graph. */
export function arrangeAction(): Offer {
  return {
    ok: true,
    ...view('tidy'),
    on     : 'arrange',
    label  : 'Arrange',
    tooltip: 'Lay the whole graph out again, left to right',
  };
}

/**
 * Asset, which selects whatever fills the slot this graph draws and opens it in the Asset editor.
 * The hash is read from the pipeline status on the click, so the offer names it as supplied.
 */
export function assetAction(slot: string | undefined): Offer {
  const control = { ...publish({}), on: 'link/asset', label: 'Asset' };
  if (!slot) {
    return {
      ...refuse('This graph names no one slot, so there is no picture of its own to show'),
      ...control,
      tooltip: 'Show what this graph draws in the Asset editor',
    };
  }
  return {
    ok: true,
    ...control,
    tooltip : `Show what ${slot} holds in the Asset editor`,
    supplies: ['assetHash'],
  };
}

export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : '⟳',
    tooltip: 'Re-read this graph from disk',
  };
}

/** Every offer the Gen Graph pane draws from this module, in bar order. */
export function controls(state: GroupState): readonly Offer[] {
  return [
    addAction(),
    arrangeAction(),
    deleteAction(state.selected, state.weighed.delete, state.target),
    duplicateAction(state.selected, state.weighed.duplicate, state.target),
    groupAction(state.selected, state.weighed.group, state.target),
    ungroupAction(state.groups, state.weighed.ungroup, state.target),
    assetAction(state.slot),
    refreshModelsAction(true, state.catalogAsOf),
    reloadAction(),
  ];
}
