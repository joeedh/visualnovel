/**
 * Puts a menu on the screen. The entry rules live in `contextmenu.ts`; only this module touches
 * path.ux, which keeps the resolution testable in node — the same split `route.ts`, `open.ts` and
 * `structfields.ts` use.
 *
 * One builder serves a right-click and the header's bar: {@link buildMenu} checks every command
 * entry, then {@link menuTemplate} turns the resolved entries into object-form rows with a
 * tooltip, a hotkey label, a greyed refusal and a nested menu per submenu. `startMenu` is
 * synchronous, so every check is awaited before anything is drawn. The checks are read-only
 * previews over state main already holds.
 */
import { Menu, createMenu, menuWrangler, startMenu, type MenuTemplate } from 'pathux';
import { api } from '../../api.js';
import type { CommandCheck, PropValue } from '../../../src/shared/ipc.js';
import { isEffectId } from '../../../src/shared/effects.js';
import type { Action } from '../../rules/anchors.js';
import type { VnContext } from '../app/context.js';
import { exec, report, say } from '../app/bridge.js';
import {
  entriesWithVerdicts,
  entryKey,
  flatEntries,
  needsCheck,
  type MenuEntry,
  type ResolvedEntry,
} from './contextmenu.js';
import { openCommandDialog } from './dialog.js';

/**
 * What runs an entry whose click is not a plain `exec`: an effect, which is a closure in the
 * renderer by definition, or a command whose props the pane supplies. Keyed by {@link entryKey}.
 */
export type MenuHandler = (props: Record<string, PropValue>, entry: MenuEntry) => void;
export type MenuHandlers = Readonly<Record<string, MenuHandler>>;

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
 * What each command and effect says it does, used for the rows that carry no sentence of their
 * own. Fetched once and kept, because the catalog is fixed for the life of the window.
 */
let describes: Record<string, string> | undefined;

async function descriptions(): Promise<Record<string, string>> {
  if (describes) return describes;
  const catalog = await api.invoke('command:catalog');
  const built: Record<string, string> = Object.fromEntries([
    ...catalog.commands.map((c) => [c.id, c.description]),
    ...(catalog.effects ?? []).map((e) => [e.id, e.description]),
  ]);
  describes = built;
  return built;
}

/**
 * The menu these entries describe, every command entry checked first, or `undefined` for an
 * empty list, which opens nothing rather than an empty box.
 */
export async function buildMenu(
  ctx: VnContext,
  title: string,
  entries: readonly MenuEntry[],
  handlers: MenuHandlers = {},
): Promise<Menu | undefined> {
  if (entries.length === 0) return undefined;

  const all = flatEntries(entries);
  const [answers, says] = await Promise.all([
    Promise.all(
      all.map((entry) =>
        needsCheck(entry)
          ? api.invoke('command:check', { id: entry.id, props: entry.props ?? {} })
          : Promise.resolve(undefined),
      ),
    ),
    descriptions(),
  ]);
  const verdicts = new Map(all.map((entry, index) => [entry, answers[index]]));

  return createMenu(ctx, title, menuTemplate(ctx, entries, verdicts, says, handlers));
}

/**
 * Object-form rows for a menu: each carries its tooltip, its hotkey label, and, where it refused,
 * the sentence path.ux composes above the tooltip while it is greyed. A submenu entry becomes a
 * nested `Menu` built from the same rules, keyed by the same verdicts.
 */
export function menuTemplate(
  ctx: VnContext,
  entries: readonly MenuEntry[],
  verdicts: ReadonlyMap<MenuEntry, CommandCheck | undefined>,
  says: Readonly<Record<string, string>>,
  handlers: MenuHandlers,
): MenuTemplate {
  const resolved = entriesWithVerdicts(
    entries,
    entries.map((entry) => verdicts.get(entry)),
    says,
  );
  return resolved.map((item, index) => {
    if (item.separator) return Menu.SEP;
    const { entry } = item;
    if (entry.submenu) {
      const menu = createMenu(
        ctx,
        entry.label,
        menuTemplate(ctx, entry.submenu, verdicts, says, handlers),
      );
      // `createMenu` files the title under the `name` attribute, but the row a parent menu draws
      // for a submenu reads `.title`; without it the entry is a blank strip
      menu.title = entry.label;
      menu.tooltip = item.tooltip;
      return menu;
    }
    // Every row carries an explicit id: `createMenu` files the callback under it, and a row
    // without one is filed under the running count, which a nested menu restarts
    return {
      name    : entry.label,
      callback: () => take(item, handlers),
      tooltip : item.tooltip,
      id      : `e${index}`,
      ...(entry.shortcut === undefined ? {} : { hotkey: entry.shortcut }),
      ...(item.refused === undefined ? {} : { validate: () => item.refused! }),
    };
  });
}

/** Show the menu these entries describe at a point. */
export async function showContextMenu(
  ctx: VnContext,
  x: number,
  y: number,
  title: string,
  entries: readonly MenuEntry[],
  handlers: MenuHandlers = {},
): Promise<void> {
  const menu = await buildMenu(ctx, title, entries, handlers);
  if (menu) startMenu(menu, x, y);
}

/**
 * Handles a click on one row. A refused entry reports its sentence instead of acting, which
 * path.ux already prevents by refusing the click. A failure of the command itself is reported by
 * `exec`, and what follows the entry runs only once the entry itself succeeded.
 */
function take(item: ResolvedEntry, handlers: MenuHandlers): void {
  if (!item.enabled) {
    say(item.refused ?? item.tooltip, true);
    return;
  }
  const { entry } = item;
  if (entry.form) {
    openCommandDialog(entry.id, entry.props);
    return;
  }
  const handler = handlers[entryKey(entry)];
  if (handler) {
    handler(entry.props ?? {}, entry);
    void runActions(entry.then ?? [], handlers);
    return;
  }
  if (isEffectId(entry.id)) {
    say(`Nothing handles ${entryKey(entry)} here.`, true);
    return;
  }
  void exec(entry.id, entry.props ?? {}).then((outcome) => {
    report(outcome);
    if (outcome.ok) void runActions(entry.then ?? [], handlers);
  });
}

/** Runs a `then` list in order, stopping at the first command that fails. */
async function runActions(actions: readonly Action[], handlers: MenuHandlers): Promise<void> {
  for (const action of actions) {
    const handler = handlers[action.id];
    if (handler) {
      handler(action.props ?? {}, { label: '', id: action.id, props: action.props });
      continue;
    }
    if (isEffectId(action.id)) {
      say(`Nothing handles ${action.id} here.`, true);
      return;
    }
    const outcome = await exec(action.id, action.props ?? {});
    report(outcome);
    if (!outcome.ok) return;
  }
}
