/**
 * Opening a context menu on the screen. The rules are `contextmenu.ts`'s; this is the half that
 * touches path.ux, so it lives in its own module and the resolution stays testable in node — the
 * same split `route.ts`/`open.ts` and `structfields.ts` already use.
 *
 * `startMenu` is synchronous, so every check is awaited before anything is drawn. They are
 * read-only previews over state main already holds; if one ever became slow enough to notice, the
 * fix is that check, not a menu that lies while it loads.
 */
import { Menu, createMenu, startMenu, type MenuTemplate, type MenuTemplateCustom } from 'pathux';
import { api } from '../api.js';
import type { VnContext } from './context.js';
import { exec, say } from './bridge.js';
import {
  entriesWithVerdicts,
  needsCheck,
  type MenuEntry,
  type ResolvedEntry,
} from './contextmenu.js';
import { openPalette } from './palette.js';

/**
 * Show the menu these entries describe. An empty list opens nothing at all, rather than an empty
 * box — a node kind with nothing to offer says so by offering nothing.
 */
export async function showContextMenu(
  ctx: VnContext,
  x: number,
  y: number,
  title: string,
  entries: readonly MenuEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const verdicts = await Promise.all(
    entries.map((entry) =>
      needsCheck(entry)
        ? api.invoke('command:check', { id: entry.id, props: entry.props ?? {} })
        : Promise.resolve(undefined),
    ),
  );

  // Every row carries an explicit id in the last slot: `createMenu` reads `item[5]` for any row
  // longer than four, so a row with a tooltip and no id is registered under `undefined` and its
  // callback is never found.
  const templ: MenuTemplate = entriesWithVerdicts(entries, verdicts).map((item, index) =>
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
 * What clicking one does. A refusal reports the command's own sentence instead of executing, and
 * a failure of the command itself is already reported by `exec` — one error path, not a second
 * convention for the one surface that happens to be a menu.
 */
function take(item: ResolvedEntry): void {
  if (!item.enabled) {
    say(item.message, true);
    return;
  }
  const { id, props, form } = item.entry;
  if (form) {
    openPalette(id, props);
    return;
  }
  void exec(id, props ?? {}).then((outcome) => {
    if (outcome.ok) say(outcome.record.message);
  });
}
