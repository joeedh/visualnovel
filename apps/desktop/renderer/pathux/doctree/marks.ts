/**
 * Which rows of the Documents pane are marked, and how a click changes that. Marked rows are the
 * pane's own: `ui.docPath` stays the one app-wide selection, and the marks are what the tree's
 * file acts will take. Pure, so the pane applies the answers and the rules are tested without a DOM.
 */
import { markable, type DocRow } from './doctree.js';
import type { ClickMods } from './treeview.js';
import { remapPath, type FileMove } from '../../../src/shared/fileops.js';

/** The marked rows as node ids in click order, and the last row clicked without Shift. */
export interface MarkState {
  marks: readonly string[];
  anchor: string;
}

export const NO_MARKS: MarkState = { marks: [], anchor: '' };

/** A click's effect on the marks. */
export interface MarkClick {
  next: MarkState;
  /** The click also does what a plain click does: publish and open, or toggle a folder. */
  plain: boolean;
}

/**
 * The marks after a click on `row`, where `rows` are the rows drawn, in draw order. A plain click
 * marks the row alone; Ctrl toggles it; Shift marks every markable row from the anchor to it. A
 * Shift-click with no anchor drawn counts as a plain click, and any click on a row that cannot be
 * marked clears the marks.
 */
export function markClick(
  state: MarkState,
  row: DocRow,
  rows: readonly DocRow[],
  mods: ClickMods,
): MarkClick {
  const id = row.node.id;
  if (!markable(row.node)) return { next: NO_MARKS, plain: true };
  if (mods.shift) {
    const from = rows.findIndex((r) => r.node.id === state.anchor);
    const to = rows.findIndex((r) => r.node.id === id);
    if (from >= 0 && to >= 0) {
      const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1);
      const marks = range.filter((r) => markable(r.node)).map((r) => r.node.id);
      return { next: { marks, anchor: state.anchor }, plain: false };
    }
  } else if (mods.ctrl) {
    const marks = state.marks.includes(id)
      ? state.marks.filter((mark) => mark !== id)
      : [...state.marks, id];
    return { next: { marks, anchor: id }, plain: false };
  }
  return { next: { marks: [id], anchor: id }, plain: true };
}

/**
 * The marks after a right-click on `row`, and the rows its menu is about. A row that is marked
 * while others are keeps every mark, and the menu covers them all; any other row becomes the only
 * mark, or clears them when it cannot be marked.
 */
export function menuTargets(
  state: MarkState,
  row: DocRow,
): { next: MarkState; targets: readonly string[] } {
  const id = row.node.id;
  if (state.marks.length >= 2 && state.marks.includes(id)) {
    return { next: state, targets: state.marks };
  }
  if (!markable(row.node)) return { next: NO_MARKS, targets: [id] };
  return { next: { marks: [id], anchor: id }, targets: [id] };
}

/**
 * The marks with every row that is not drawn taken out, the anchor included. A refetch, a filter
 * and a collapsed folder all hide rows, and a file act must never take a row the author cannot see.
 */
export function pruneMarks(state: MarkState, rows: readonly DocRow[]): MarkState {
  const drawn = new Set(rows.map((r) => r.node.id));
  const marks = state.marks.filter((mark) => drawn.has(mark));
  const anchor = drawn.has(state.anchor) ? state.anchor : '';
  if (marks.length === state.marks.length && anchor === state.anchor) return state;
  return { marks, anchor };
}

/**
 * Answers a node id after files moved, in either tree: `file:` and `dir:` name a workspace path,
 * and `wiki:` and `wikidir:` a path under `wiki/`. An id naming anything else, or a page moved
 * out of `wiki/`, is returned unchanged, and the next redraw drops it.
 */
export function movedId(id: string, moves: readonly FileMove[]): string {
  const colon = id.indexOf(':');
  const scheme = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (scheme === 'file' || scheme === 'dir') return `${scheme}:${remapPath(rest, moves)}`;
  if (scheme !== 'wiki' && scheme !== 'wikidir') return id;
  const moved = remapPath(`wiki/${rest}`, moves);
  return moved.startsWith('wiki/') ? `${scheme}:${moved.slice('wiki/'.length)}` : id;
}

/** Carries the marks and the anchor to where their files moved, so a moved row stays marked. */
export function remapMarks(state: MarkState, moves: readonly FileMove[]): MarkState {
  return {
    marks : state.marks.map((mark) => movedId(mark, moves)),
    anchor: state.anchor === '' ? '' : movedId(state.anchor, moves),
  };
}

/**
 * The marks after files are created or moved: the drawn rows whose paths are among `paths`, in
 * draw order, with the last as the anchor.
 */
export function revealMarks(rows: readonly DocRow[], paths: readonly string[]): MarkState {
  const wanted = new Set(paths);
  const marks = rows
    .filter((r) => markable(r.node) && r.node.path !== undefined && wanted.has(r.node.path))
    .map((r) => r.node.id);
  return { marks, anchor: marks[marks.length - 1] ?? '' };
}
