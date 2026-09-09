/**
 * Every menu the app draws, as data over a state: the document tree's right-click over one node
 * of each kind, the shot, line and card menus over a fixture each, the conversation bar's Threads
 * menu over a saved list, and the header's four menus over `HeaderMenuState`. The derived model's driver reads the table, and the sweep reads the same
 * records through `window.__vnAnchors.menus()`, so no pane has to be opened to list a menu.
 *
 * A menu is built on demand and gone again before a tour could point at it, so nothing anchors
 * one. Every record here therefore names the palette route, and a tour step naming one of these
 * commands is routed rather than rung.
 */
import { MENU_SEP, type MenuEntry } from '../pathux/chrome/contextmenu.js';
import { MENU_NODES, menuFor } from '../pathux/doctree/doctree.js';
import { cardMenu } from '../pathux/interactions/branch.js';
import { lineMenu } from '../pathux/interactions/script.js';
import { shotMenu } from '../pathux/interactions/timeline.js';
import { headerMenus, type HeaderMenuState } from './headermenus.js';
import { threadsMenu, type ThreadsMenuState } from './convobar.js';
import type { Situation } from './situations/situation.js';
import { SITUATIONS as CARDMENU, type CardMenuState } from './situations/cardmenu.js';
import { SITUATIONS as HEADERMENUS } from './situations/headermenus.js';
import { SITUATIONS as LINEMENU, type LineMenuState } from './situations/linemenu.js';
import { SITUATIONS as SHOTMENU, type ShotMenuState } from './situations/shotmenu.js';
import { SITUATIONS as THREADSMENU } from './situations/threadsmenu.js';
import type { AnchorHome } from '../../src/shared/editors.js';
import type { DocNode } from '../../src/shared/ipc.js';
import type { UxMenuRecord } from '../../src/shared/uxmodel.js';

/** One menu as drawn: what it was drawn for, and its rows. */
export interface OpenMenu {
  when: string;
  entries: readonly MenuEntry[];
}

/** One menu source: where it is drawn, the states to build it over, and the menus each yields. */
export interface MenuRow<S> {
  module: string;
  editor: AnchorHome;
  /** The module's source, repo-relative, so a record says where its rule lives. */
  file: string;
  situations: readonly Situation<S>[];
  menus(state: S): readonly OpenMenu[];
}

const row = <S>(
  module: string,
  editor: AnchorHome,
  file: string,
  situations: readonly Situation<S>[],
  menus: (state: S) => readonly OpenMenu[],
): MenuRow<S> => ({ module, editor, file, situations, menus });

/** The tree's one situation: one node of each kind, so the menu's coverage is total. */
const EVERY_KIND: Situation<readonly DocNode[]> = {
  name : 'every-kind',
  why: 'One node of each kind the tree draws, so the menu’s coverage is total rather than a project’s.',
  state: MENU_NODES,
};

/** Every menu source, in the order the file lists them. */
export const MENU_ROWS: readonly MenuRow<unknown>[] = [
  row(
    'doctree',
    'documents',
    'apps/desktop/renderer/pathux/doctree/doctree.ts',
    [EVERY_KIND],
    (nodes) => nodes.map((node) => ({ when: node.id, entries: menuFor(node) })),
  ),
  row(
    'shotmenu',
    'timeline',
    'apps/desktop/renderer/pathux/interactions/timeline.ts',
    SHOTMENU,
    ({ sceneId, shot }: ShotMenuState) => [
      { when: `shot:${sceneId}/${shot.id}`, entries: shotMenu(sceneId, shot) },
    ],
  ),
  row(
    'linemenu',
    'script',
    'apps/desktop/renderer/pathux/interactions/script.ts',
    LINEMENU,
    ({ scene, lineId }: LineMenuState) => [
      { when: `line:${lineId}`, entries: lineMenu(scene, lineId) },
    ],
  ),
  row(
    'cardmenu',
    'branches',
    'apps/desktop/renderer/pathux/interactions/branch.ts',
    CARDMENU,
    ({ id, stub }: CardMenuState) => [{ when: `card:${id}`, entries: cardMenu(id, stub) }],
  ),
  row(
    'threadsmenu',
    'convo',
    'apps/desktop/renderer/rules/convobar.ts',
    THREADSMENU,
    (state: ThreadsMenuState) => [{ when: 'threads', entries: threadsMenu(state) }],
  ),
  row(
    'headermenus',
    'header',
    'apps/desktop/renderer/rules/headermenus.ts',
    HEADERMENUS,
    (state: HeaderMenuState) => headerMenus(state),
  ),
] as readonly MenuRow<unknown>[];

/**
 * One menu's rows as records, its submenus under `<when>/<menu>`. A separator is not a record,
 * and a submenu entry is recorded as the `menu.open` effect it is.
 */
function recordsOf(row: MenuRow<unknown>, situation: string, menu: OpenMenu): UxMenuRecord[] {
  const records: UxMenuRecord[] = [];
  for (const entry of menu.entries) {
    if (entry.id === MENU_SEP) continue;
    records.push({
      via   : 'menu',
      editor: row.editor,
      module: row.module,
      situation,
      when : menu.when,
      id   : entry.id,
      label: entry.label,
      ...(entry.tooltip === undefined ? {} : { tooltip: entry.tooltip }),
      ...(entry.props === undefined ? {} : { props: { ...entry.props } }),
      ...(entry.on === undefined ? {} : { on: entry.on }),
      ...(entry.supplies === undefined ? {} : { supplies: [...entry.supplies] }),
      ...(entry.form ? { form: true } : {}),
      ...(entry.then === undefined ? {} : { then: entry.then.map((a) => ({ ...a })) }),
      ...(entry.refused === undefined ? {} : { refused: entry.refused }),
      ...(entry.shortcut === undefined ? {} : { shortcut: entry.shortcut }),
    });
    if (entry.submenu) {
      const name = String(entry.props?.['menu'] ?? entry.label);
      records.push(
        ...recordsOf(row, situation, { when: `${menu.when}/${name}`, entries: entry.submenu }),
      );
    }
  }
  return records;
}

/** Every menu record: table order, then situation order, then draw order. */
export function menuRecords(): UxMenuRecord[] {
  return MENU_ROWS.flatMap((row) =>
    row.situations.flatMap((situation) =>
      row.menus(situation.state).flatMap((menu) => recordsOf(row, situation.name, menu)),
    ),
  );
}
