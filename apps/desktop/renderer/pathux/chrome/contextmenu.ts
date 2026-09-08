/**
 * Builds what a menu offers, and checks whether the author may take each entry.
 *
 * An entry holds a command or effect id and its props rather than a callback. `stack.check`
 * resolves a command entry before the menu opens, and `exec` resolves it again when it is clicked.
 * A menu item that is not a command or an effect has no place here: if an action is worth a
 * right-click it is worth being in the palette, the catalog and the provenance log, and a bespoke
 * `contextmenu` handler that calls `exec` without checking would let a surface offer what the
 * command would refuse.
 *
 * This module is pure, with no `pathux` import, so the resolution rules are testable in node.
 * Opening the menu on a screen happens in `showmenu.ts`.
 */
import type { CommandCheck, PropValue } from '../../../src/shared/ipc.js';
import { isEffectId } from '../../../src/shared/effects.js';
import type { Action } from '../../rules/anchors.js';

/** The id a separator carries. Not a command: never checked, never run. */
export const MENU_SEP = '-';

export interface MenuEntry {
  label: string;
  /** A command id, an effect id, or {@link MENU_SEP}. */
  id: string;
  props?: Record<string, PropValue>;
  /** Tells two entries with one id apart, and keys the handler for one that runs a closure. */
  on?: string;
  /** The row's own sentence. Absent, the row shows what the registry says the id does. */
  tooltip?: string;
  /** The key combination drawn at the row's right, as the shell binds it. */
  shortcut?: string;
  /**
   * Open the palette on this command's form instead of running it. Two entries need it: one whose
   * argument a menu cannot supply (a variant id, a line of prose), and one that is `confirm: true`,
   * because the palette is where a command says what it is about to do before it does it.
   *
   * Such an entry is deliberately not checked: its props are incomplete by design, so the refusal
   * a check would return is about the blank the author is on their way to filling in.
   */
  form?: boolean;
  /**
   * Prop names the click reads from the pane it acts on, the way a control's `supplies` are read
   * from its widget. The row carries none of them, so it is not checked, and its handler is what
   * runs it.
   */
  supplies?: readonly string[];
  /**
   * A refusal the surface already knows, drawn exactly as a checked one and never run. Set it when
   * the precondition is about what the entry would name rather than about the project: a line no
   * shot covers has no asset to open, so there is no id to ask a command about. It is not a licence
   * to pre-judge what `check` would say: a command that can answer is asked.
   */
  refused?: string;
  /** What follows the entry's own action, in order, each run only if the one before succeeded. */
  then?: readonly Action[];
  /** The rows of a nested menu. The entry itself is a `menu.open` effect naming that menu. */
  submenu?: readonly MenuEntry[];
}

/** A separator row, written once so every menu spells it the same way. */
export const SEPARATOR: MenuEntry = { label: MENU_SEP, id: MENU_SEP };

/** One item as it will be drawn: whether clicking it acts, and the sentences for it. */
export interface ResolvedEntry {
  entry: MenuEntry;
  separator: boolean;
  /** False only for a declared refusal. `undeclared` is not permission, but it leaves this true. */
  enabled: boolean;
  /**
   * The row's tooltip: the entry's own sentence, else what the registry says the command or
   * effect does. `''` only where neither exists.
   */
  tooltip: string;
  /** Why the row is greyed, composed above the tooltip. Absent on an enabled row. */
  refused?: string;
}

/**
 * Whether `check` is worth asking for this entry. The same test fixes its slot in `verdicts`. An
 * effect has no precondition in the stack, an entry that supplies its props from the pane has
 * nothing complete to ask about, and a submenu entry only opens more rows.
 */
export function needsCheck(entry: MenuEntry): boolean {
  return (
    entry.id !== MENU_SEP &&
    !entry.form &&
    entry.refused === undefined &&
    entry.supplies === undefined &&
    entry.submenu === undefined &&
    !isEffectId(entry.id)
  );
}

/** The key a handler is filed under: the id, and `#on` where the entry carries one. */
export function entryKey(entry: MenuEntry): string {
  return entry.on === undefined ? entry.id : `${entry.id}#${entry.on}`;
}

/** Every entry in a menu and its submenus, in draw order. */
export function flatEntries(entries: readonly MenuEntry[]): MenuEntry[] {
  return entries.flatMap((entry) => [entry, ...flatEntries(entry.submenu ?? [])]);
}

/**
 * The entries as they will be drawn, given what `check` answered. `verdicts` is positional over
 * `entries` — `undefined` wherever {@link needsCheck} said not to ask — so an entry and its verdict
 * cannot drift apart the way a filtered second list would.
 *
 * A refusal is shown rather than hidden: the row is greyed with the sentence composed above its
 * tooltip, because hiding the option would leave the author guessing why the one they remember is
 * gone. The refusal sentence is the whole value of `check`, and it should reach the surface that
 * asked.
 *
 * `describes` maps a command or effect id to what the registry says it does. It is the tooltip of
 * every row that carries no sentence of its own, so a vague one is fixed in the definition rather
 * than written out again here.
 */
export function entriesWithVerdicts(
  entries: readonly MenuEntry[],
  verdicts: readonly (CommandCheck | undefined)[],
  describes: Readonly<Record<string, string>> = {},
): ResolvedEntry[] {
  return entries.map((entry, index) => {
    if (entry.id === MENU_SEP) return { entry, separator: true, enabled: false, tooltip: '' };
    const tooltip = entry.tooltip ?? describes[entry.id] ?? '';
    if (entry.refused !== undefined) {
      return { entry, separator: false, enabled: false, tooltip, refused: entry.refused };
    }
    const check = verdicts[index];
    if (check?.state === 'refuse') {
      return { entry, separator: false, enabled: false, tooltip, refused: check.message };
    }
    return {
      entry,
      separator: false,
      enabled  : true,
      tooltip  : check && check.state !== 'undeclared' && check.message ? check.message : tooltip,
    };
  });
}
