/**
 * Puts a context menu on the screen. The entry rules live in `contextmenu.ts`; only this module
 * touches path.ux, which keeps the resolution testable in node — the same split `route.ts`,
 * `open.ts` and `structfields.ts` use.
 *
 * `startMenu` is synchronous, so every check is awaited before anything is drawn. The checks are
 * read-only previews over state main already holds.
 */
import {
  Menu,
  createMenu,
  menuWrangler,
  startMenu,
  type MenuTemplate,
  type MenuTemplateCustom,
} from 'pathux';
import { api } from '../../api.js';
import type { VnContext } from '../app/context.js';
import { exec, report, say } from '../app/bridge.js';
import {
  entriesWithVerdicts,
  needsCheck,
  type MenuEntry,
  type ResolvedEntry,
} from './contextmenu.js';
import { openCommandDialog } from './dialog.js';

/**
 * Whether a path.ux menu is up right now.
 *
 * A surface underneath a menu must ask on pointer-down. The wrangler closes the menu on mouse-up,
 * so by the time the dismissing `click` arrives the menu is gone and the click looks like a first
 * one.
 */
export function menuIsOpen(): boolean {
  return menuWrangler.menu !== undefined;
}

/**
 * What each command says it does, used for the rows that carry no refusal. Fetched once and kept,
 * because the catalog is fixed for the life of the window.
 */
let describes: Record<string, string> | undefined;

async function commandDescriptions(): Promise<Record<string, string>> {
  if (!describes) {
    const catalog = await api.invoke('command:catalog');
    describes = Object.fromEntries(catalog.commands.map((c) => [c.id, c.description]));
  }
  return describes;
}

/**
 * Show the menu these entries describe. An empty list opens nothing rather than an empty box.
 */
export async function showContextMenu(
  ctx: VnContext,
  x: number,
  y: number,
  title: string,
  entries: readonly MenuEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const [verdicts, says] = await Promise.all([
    Promise.all(
      entries.map((entry) =>
        needsCheck(entry)
          ? api.invoke('command:check', { id: entry.id, props: entry.props ?? {} })
          : Promise.resolve(undefined),
      ),
    ),
    commandDescriptions(),
  ]);

  // Every row carries an explicit id in the last slot: `createMenu` reads `item[5]` for any row
  // longer than four, so a row with a tooltip and no id is registered under `undefined` and its
  // callback is never found.
  const templ: MenuTemplate = entriesWithVerdicts(entries, verdicts, says).map((item, index) =>
    item.separator
      ? Menu.SEP
      : ([
          item.label,
          () => take(item),
          undefined,
          undefined,
          item.message,
          `e${index}`,
        ] as MenuTemplateCustom),
  );

  startMenu(createMenu(ctx, title, templ), x, y);
}

/**
 * Handles a click on one row. A refused entry reports the command's own sentence instead of
 * executing. A failure of the command itself is reported by `exec`.
 */
function take(item: ResolvedEntry): void {
  if (!item.enabled) {
    say(item.message, true);
    return;
  }
  const { id, props, form } = item.entry;
  if (form) {
    openCommandDialog(id, props);
    return;
  }
  void exec(id, props ?? {}).then(report);
}
