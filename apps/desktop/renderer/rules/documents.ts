/**
 * What the Documents pane offers: its two writes, which are never refused, and one offer per
 * tree row, which is what a click on the row does. A row publishes the selection it names and
 * then opens the editor that claims it, or expands where it names nothing.
 */
import { type Action, type Offer } from './anchors.js';
import { expand, publish, type Publishes } from './effects.js';
import { openOf, routeFor } from './route.js';
import {
  nodeIsSelected,
  nodeKey,
  publishedBy,
  selectionForNode,
  type Selection,
} from './selection.js';
import type { EditorId } from '../../src/shared/editors.js';
import type { DocNode } from '../../src/shared/ipc.js';

/** What the pane knows about a drawn row that the node does not carry. */
export interface RowState {
  node: DocNode;
  /** Has children to show. A node with none draws no twisty rather than an inert one. */
  expandable: boolean;
  expanded: boolean;
}

/** What the Documents pane reads when it draws its bar, its rename box and its rows. */
export interface DocumentsState {
  /** The document whose row holds the rename box, while one does. */
  renaming?: { path: string; name: string };
  /** The rows on screen, the selection they are drawn against and the editors that are up. */
  rows?: {
    list: readonly RowState[];
    selection: Selection;
    visible: readonly EditorId[];
  };
}

/**
 * Start a new document. The button rather than the row it opens, because pressing it is where
 * writing a document starts, and the kind and the name are both typed after it.
 */
export function createAction(): Offer {
  return {
    ok      : true,
    id      : 'doc.create',
    props   : {},
    label   : 'New…',
    tooltip : 'Add a character, location, page or skill to this project',
    supplies: ['kind', 'name'],
  };
}

/** Rename one document. The box's text is the new name, so the commit supplies it. */
export function renameAction(target: { path: string; name: string }): Offer {
  return {
    ok      : true,
    id      : 'doc.rename',
    props   : { path: target.path },
    label   : target.name,
    tooltip : 'Type the new name — Enter renames the document, Escape leaves it as it was',
    supplies: ['name'],
  };
}

/**
 * What double-clicking this node would rename, or `undefined` if it is not renamable. Answering
 * with the props `doc.rename` takes keeps the surface from assembling them: a row that can be
 * renamed is exactly a row this returns something for.
 *
 * A scene is deliberately not renamable. Its label is its id, and its id is its filename, the
 * config's `start:` and every `[[goto:]]` pointing at it — one of those is a rename and the rest
 * are a refactor. Assets, shots and branch headings are left out too: none is named by a document.
 *
 * A skill is left out for a different reason. It has a path and a label, so it looks renamable, but
 * `doc.rename` renames a document by rewriting a `title:` in its front-matter, and a `SKILL.md` has
 * no `title:`. Its label is `name:`, which is a different key, and its id is the directory, which no
 * rewrite of the file could move. Renaming a skill is `edit_skill`, or the Skills pane; a
 * double-click here would silently write a key nobody reads.
 */
export function renameOf(node: DocNode): { path: string; name: string } | undefined {
  if (!node.path) return undefined;
  switch (node.kind) {
    case 'character':
    case 'location':
    case 'wiki':
      return { path: node.path, name: node.label };
    default:
      return undefined;
  }
}

/** A location known only from a scene heading: named, drawn, and with no file behind it. */
export function sheetless(node: DocNode): boolean {
  return node.kind === 'location' && node.path === undefined;
}

/**
 * What a row says on hover, and every row says something. A path is the useful thing to say where
 * there is one; the rest is what a row with no file says instead.
 *
 * The three facts the tree adds to the node are the arguments, because none is on `DocNode`:
 * `renamable` is `renameOf(node) !== undefined`, `sheetless` is a location known only from a
 * scene heading — its second click writes a sheet rather than renaming one — and `expanded` is
 * the row's own state, which only a counted stand-in has anything to say about.
 */
export function rowTitle(
  node: DocNode,
  opts: { renamable: boolean; sheetless: boolean; expanded: boolean },
): string {
  if (node.path) {
    return opts.renamable ? `${node.path} — double-click the name to rename it` : node.path;
  }
  if (node.note) return node.note;
  if (opts.sheetless) return 'Only a heading names this place — double-click to write its sheet';
  if (node.kind === 'branch' || node.kind === 'assetkind') {
    return 'Show or hide what is filed under this heading';
  }
  if (node.kind === 'more') {
    return opts.expanded
      ? 'Hide the rest of this list again'
      : 'More than the tree draws at once — click to show the rest';
  }
  if (node.kind === 'shot' && node.hash) {
    return 'Open this shot in its editor — double-click to show the frame it was drawn as';
  }
  return `Open this ${node.kind} in its editor`;
}

/**
 * What clicking a row does, as the pane's `pick` performs it. A row naming nothing the shell
 * tracks expands where it can, so clicking the word "Characters" opens the heading; an asset row
 * already selected expands too, since its children are that slot's earlier takes. Every other
 * row publishes the fields it changes and then opens the editor that claims it, where one does,
 * with `where` from the route: `here` for a claimant already on screen, `elsewhere` otherwise.
 *
 * The key is `item:<kind>/<key>` on a publishing row, which is the address a tour's `select`
 * step names, and `fx:tree.expand#<kind>/<key>` on a row that only expands.
 */
export function rowAction(
  row: RowState,
  selection: Selection,
  visible: readonly EditorId[],
): Offer {
  const { node } = row;
  const on = `${node.kind}/${nodeKey(node)}`;
  const control = {
    on,
    label  : node.label,
    tooltip: rowTitle(node, {
      renamable: renameOf(node) !== undefined,
      sheetless: sheetless(node),
      expanded : row.expanded,
    }),
  };
  const unchanged = selectionForNode(node, selection) === selection;
  const reselected = node.kind === 'asset' && nodeIsSelected(node, selection);
  if (row.expandable && (unchanged || reselected)) {
    return { ok: true, ...expand(node.id), ...control };
  }
  const open = unchanged ? null : openOf(routeFor({ node, visible }));
  const then: Action[] = open ? [open] : [];
  return {
    ok: true,
    ...publish(publishedBy(node, selection) as Publishes),
    ...control,
    ...(then.length > 0 ? { then } : {}),
  };
}

/** Every offer the Documents pane draws from this module. */
export function controls(state: DocumentsState): readonly Offer[] {
  const list: Offer[] = [createAction()];
  if (state.renaming) list.push(renameAction(state.renaming));
  if (state.rows) {
    const { selection, visible } = state.rows;
    for (const row of state.rows.list) list.push(rowAction(row, selection, visible));
  }
  return list;
}
