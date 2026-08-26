/**
 * The tree, as a widget any editor can draw. It takes flattened `DocRow`s and a handful of
 * callbacks and knows nothing about what the nodes mean. The Documents pane supplies its five
 * branches, the Skills pane supplies its skills, and neither has to reimplement the three things
 * that make a DOM tree behave.
 *
 * Those three are the reason this is shared rather than copied:
 *
 * - The double click is counted rather than listened for. The first click rebuilds the rows, so by
 *   the time a `dblclick` would be dispatched the element both clicks landed on no longer exists.
 *   `countClick` is the rule, and the latch lives per root element so a rebuild cannot lose it.
 * - The dismiss latch is capture-phase and armed on pointer-down, which is the last moment a
 *   context menu is still open. Without it a right-click's dismissal lands as an ordinary click on
 *   the row the pointer was resting over, and a right-click rearranges the tree.
 * - No row hovers silently. `RowLook.title` is required and must never be `''`. What a row says is
 *   a rule about node kinds, so it lives in `rowTitle` in `doctree.ts` rather than here.
 *
 * `dataset.id` and `.tv-label` are contract: a host doing an in-place rename finds the row by the
 * first and replaces the second, because DOM identity does not survive a rebuild but a node id
 * does. `rowElementFor` is the supported way to do the lookup.
 */
import type { DocRow } from './doctree.js';
import TREEVIEW_CSS from '../styles/treeview.css?inline';

export { TREEVIEW_CSS };

/** The maximum interval between two clicks on one row that counts as a second click, set to the platform default. */
export const DOUBLE_CLICK_MS = 500;

/** What only the host knows about a row, and the renderer cannot derive from the node. */
export interface RowLook {
  selected: boolean;
  /** Must never be `''`; an empty title would let a row hover silently, the bug this field exists to prevent. */
  title: string;
}

export interface TreeHandlers {
  look(row: DocRow): RowLook;
  /** The twisty was hit. The host owns the expanded set, so it decides what that means. */
  onToggle(id: string): void;
  onClick(row: DocRow): void;
  /** A second click on the row the last one landed on, inside `DOUBLE_CLICK_MS`. */
  onSecondClick?(row: DocRow): void;
  onMenu?(row: DocRow, x: number, y: number): void;
}

/** Records the last row clicked and when, so a second click on the same row can be recognised. */
export interface ClickLatch {
  id: string;
  at: number;
}

/** The latch at rest. `at: -1` because a `timeStamp` of 0 is a real moment. */
export const NO_CLICK: ClickLatch = { id: '', at: -1 };

/**
 * Whether this click is the second on one row, and the latch to carry forward. A counted second
 * click resets the latch rather than becoming the first of the next pair, so three clicks are one
 * rename and not two.
 */
export function countClick(
  last: ClickLatch,
  id: string,
  at: number,
): { again: boolean; next: ClickLatch } {
  const again = last.id === id && at - last.at < DOUBLE_CLICK_MS;
  return { again, next: again ? NO_CLICK : { id, at } };
}

/**
 * One latch per rows container, so it survives the rebuild the first click causes. Keyed by the
 * element rather than held by the host, because the host would then have to thread it through
 * `renderTree` on every draw for no decision of its own.
 */
const LATCHES = new WeakMap<HTMLElement, ClickLatch>();

/**
 * Swallow the click that dismisses a context menu. path.ux closes a menu on mouse-up, so what
 * reaches the tree afterwards is an ordinary first click, and it selects or toggles the row the
 * pointer happened to be resting over. From the author's seat that is a right-click rearranging
 * the tree, which is what a right-click must not do.
 *
 * Pointer-down is the only moment the question can be asked, because it is the last one at which
 * a menu is still open. Both listeners are capture-phase, so one latch covers every row and twisty
 * under `surface`; pass the pane's surface rather than the rows and whatever else it hosts is
 * covered too. The latch is assigned on each pointer-down, so a gesture that never becomes a
 * click cannot leave it armed.
 */
export function armDismissLatch(surface: HTMLElement, menuIsOpen: () => boolean): void {
  let dismissing = false;
  surface.addEventListener(
    'pointerdown',
    () => {
      dismissing = menuIsOpen();
    },
    true,
  );
  surface.addEventListener(
    'click',
    (event) => {
      if (!dismissing) return;
      dismissing = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}

/** The row drawn for `id`, or `undefined` — how a host reaches a row it did not keep. */
export function rowElementFor(root: HTMLElement, id: string): HTMLElement | undefined {
  return [...root.children].find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.dataset['id'] === id,
  );
}

/** Draw `rows` into `root`, replacing whatever was there. */
export function renderTree(root: HTMLElement, rows: readonly DocRow[], h: TreeHandlers): void {
  root.textContent = '';
  for (const row of rows) root.appendChild(rowEl(root, row, h));
}

function rowEl(root: HTMLElement, row: DocRow, h: TreeHandlers): HTMLElement {
  const { node } = row;
  // A counted stand-in behaves like any other row now that it carries what it stood for. It draws
  // greyed because it is a count rather than a thing, but it still responds to a click.
  const counted = node.kind === 'more';
  const group = node.kind === 'branch' || node.kind === 'assetkind';
  const look = h.look(row);

  const line = el('div', 'tv-row') as HTMLDivElement;
  // The node's own id, so a rename opened by the second of two clicks can find the row the
  // first click's rebuild replaced. DOM identity does not survive a rebuild; this does.
  line.dataset['id'] = node.id;
  if (counted) line.classList.add('inert');
  if (group) line.classList.add('group');
  if (look.selected) line.classList.add('sel');
  line.style.paddingLeft = `${4 + row.depth * 13}px`;
  line.title = look.title;

  const twisty = el('span', 'tv-twisty', row.expandable ? (row.expanded ? '▾' : '▸') : '');
  if (row.expandable) {
    twisty.title = row.expanded ? 'Hide what is under this' : 'Show what is under this';
  }
  line.appendChild(twisty);
  line.appendChild(el('span', 'tv-label', node.label));
  if (node.badge) {
    const badge = el('span', 'tv-badge', node.badge);
    // These badges are facts about the disk rather than about the story, so they must not look
    // like the others
    if (node.badge === 'unreadable' || node.badge === 'unreachable') badge.classList.add('bad');
    line.appendChild(badge);
  }

  // The twisty is its own click target, so a node that is both a place and a container (a scene
  // with shots under it) can be opened without being selected and selected without being opened.
  twisty.addEventListener('click', (event) => {
    event.stopPropagation();
    if (row.expandable) h.onToggle(node.id);
  });
  line.addEventListener('click', (event) => {
    const { again, next } = countClick(LATCHES.get(root) ?? NO_CLICK, node.id, event.timeStamp);
    LATCHES.set(root, next);
    h.onClick(row);
    if (again) h.onSecondClick?.(row);
  });
  // The listener is unconditional and the host decides what a menu holds. A host answers with
  // nothing for a heading or a count, and shows nothing for an empty list.
  line.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    h.onMenu?.(row, event.clientX, event.clientY);
  });
  return line;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
