/**
 * What the Documents pane offers: its two writes, which are never refused, and one offer per
 * tree row, which is what a click on the row does. A row publishes the selection it names and
 * then opens the editor that claims it, or expands where it names nothing.
 */
import { type Action, type Offer } from './anchors.js';
import { EVERY_NODE, expand, publish, view, type Publishes } from './effects.js';
import { openOf, routeFor } from './route.js';
import { cellAction, type StripAsset } from './assetstrip.js';
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
  /** Which grouping the pane shows; `documents` when unset. */
  mode?: DocMode;
  /** The document whose row holds the rename box, while one does. */
  renaming?: { path: string; name: string };
  /** The rows on screen, the selection they are drawn against and the editors that are up. */
  rows?: {
    list: readonly RowState[];
    selection: Selection;
    visible: readonly EditorId[];
  };
  /** The backlink panel under the rows, drawn for the picked character or location. */
  panel?: BacklinkPanel;
}

/** The two groupings the tree can show. */
export type DocMode = 'files' | 'documents';

/** What the panel draws: the sheet, the art, and the scenes and shots the subject appears in. */
export interface BacklinkPanel {
  /** The sheet the subject was discovered in, and whether it lives in the story bible. */
  sheet?: { path: string; wiki: boolean };
  assets: readonly StripAsset[];
  scenes: readonly string[];
  shots: readonly { scene: string; shot: string }[];
  /** The editors some pane is showing, which the route a link opens with depends on. */
  visible: readonly EditorId[];
}

/**
 * The bar's mode toggle. Labelled with the mode it is in rather than the one it would switch to,
 * matching the header's own PLAN/EXECUTE button.
 */
export function modeAction(mode: DocMode): Offer {
  return {
    ok: true,
    ...view('mode'),
    on     : 'mode',
    label  : mode === 'files' ? 'FILES' : 'DOCUMENTS',
    tooltip:
      mode === 'files'
        ? 'Showing every file on disk. Click to group by what the documents are instead.'
        : 'Showing cast, locations and scenes. Click to see the folders they live in instead.',
  };
}

/** The bar's Refresh. */
export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : 'Refresh',
    tooltip: 'Re-read the project from disk',
  };
}

/**
 * The bar's fold-everything button. Folding the tree back up is not the same as reloading:
 * expansion survives every refetch, so without it a tree left with dozens of open branches has
 * to be closed row by row.
 */
export function collapseAction(): Offer {
  return {
    ok: true,
    ...expand(EVERY_NODE),
    on     : 'all',
    label  : 'Close all',
    tooltip: 'Fold every branch of the tree shut',
  };
}

/**
 * The panel's sheet row. Labelled by where the sheet lives, because a character filed in the
 * story bible is still a character and the author would otherwise not know which of the two it is.
 */
export function sheetLinkAction(
  sheet: { path: string; wiki: boolean },
  visible: readonly EditorId[],
): Offer {
  const node: DocNode = {
    id   : `wiki:${sheet.path}`,
    kind : 'wiki',
    label: sheet.path,
    path : sheet.path,
  };
  const open = openOf(routeFor({ node, visible }));
  return {
    ok: true,
    ...publish({ docPath: sheet.path }),
    on     : 'link/sheet',
    label  : `${sheet.wiki ? 'in the story bible' : 'sheet'} · ${sheet.path}`,
    tooltip: `Open ${sheet.path}`,
    ...(open ? { then: [open] } : {}),
  };
}

/** A panel row naming a scene the subject appears in, which selects that scene. */
export function sceneLinkAction(scene: string): Offer {
  return {
    ok: true,
    ...publish({ sceneId: scene, shotId: '' }),
    on     : `link/scene/${scene}`,
    label  : scene,
    tooltip: `Go to ${scene}`,
  };
}

/** A panel row naming a shot the subject is framed in, which selects the shot and its scene. */
export function shotLinkAction(scene: string, shot: string): Offer {
  return {
    ok: true,
    ...publish({ sceneId: scene, shotId: shot }),
    on     : `link/shot/${scene}/${shot}`,
    label  : shot,
    tooltip: `Go to this shot of ${scene}`,
  };
}

/** Every offer the panel draws, in draw order: the sheet, the art, the scenes, the shots. */
export function panelControls(panel: BacklinkPanel): Offer[] {
  return [
    ...(panel.sheet ? [sheetLinkAction(panel.sheet, panel.visible)] : []),
    ...panel.assets.map((asset) => cellAction(asset, panel.visible)),
    ...panel.scenes.map(sceneLinkAction),
    ...panel.shots.map(({ scene, shot }) => shotLinkAction(scene, shot)),
  ];
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

/** Every offer the Documents pane draws from this module: the bar, the rename box, the rows, the panel. */
export function controls(state: DocumentsState): readonly Offer[] {
  const list: Offer[] = [
    modeAction(state.mode ?? 'documents'),
    createAction(),
    reloadAction(),
    collapseAction(),
  ];
  if (state.renaming) list.push(renameAction(state.renaming));
  if (state.rows) {
    const { selection, visible } = state.rows;
    for (const row of state.rows.list) list.push(rowAction(row, selection, visible));
  }
  if (state.panel) list.push(...panelControls(state.panel));
  return list;
}
