/**
 * Builds what a right-click offers, and checks whether the author may take each entry.
 *
 * An entry holds a command id and its props rather than a callback. `stack.check` resolves it
 * before the menu opens, and `exec` resolves it again when it is clicked. A menu item that is
 * not a command has no place here: if an action is worth a right-click it is worth being in the
 * palette, the catalog and the provenance log, and a bespoke `contextmenu` handler that calls
 * `exec` without checking would let a surface offer what the command would refuse.
 *
 * This module is pure, with no `pathux` import, so the resolution rules are testable in node.
 * Opening the menu on a screen happens in `showmenu.ts`.
 */
import type { CommandCheck, PropValue } from '../../src/shared/ipc.js';

/** The id a separator carries. Not a command: never checked, never run. */
export const MENU_SEP = '-';

export interface MenuEntry {
  label: string;
  /** A command id, or {@link MENU_SEP}. */
  id: string;
  props?: Record<string, PropValue>;
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
   * A refusal the surface already knows, drawn exactly as a checked one and never run. Set it when
   * the precondition is about what the entry would name rather than about the project: a line no
   * shot covers has no asset to open, so there is no id to ask a command about. It is not a licence
   * to pre-judge what `check` would say — a command that can answer is asked.
   */
  refused?: string;
}

/** One item as it will be drawn: its label, whether clicking it acts, and the sentence for it. */
export interface ResolvedEntry {
  entry: MenuEntry;
  /** What the menu draws — the label, marked when the command refused it. */
  label: string;
  separator: boolean;
  /** False only for a declared refusal. `undeclared` is not permission, but it leaves this true. */
  enabled: boolean;
  /**
   * The row's tooltip: a refusal is its own sentence, and everything else falls back to what the
   * registry says the command does. `''` only where neither exists.
   */
  message: string;
}

/** U+20E0, combining enclosing no-symbol: the label reads as struck through rather than missing. */
const REFUSED = '⃠ ';

/** Whether `check` is worth asking for this entry. The same test fixes its slot in `verdicts`. */
export function needsCheck(entry: MenuEntry): boolean {
  return entry.id !== MENU_SEP && !entry.form && entry.refused === undefined;
}

/**
 * The entries as they will be drawn, given what `check` answered. `verdicts` is positional over
 * `entries` — `undefined` wherever {@link needsCheck} said not to ask — so an entry and its verdict
 * cannot drift apart the way a filtered second list would.
 *
 * A refusal is shown rather than hidden: path.ux's menu template has no per-item disabled state,
 * and hiding the option would leave the author guessing why the one they remember is gone. The
 * refusal sentence is the whole value of `check`, and it should reach the surface that asked.
 *
 * `describes` maps a command id to what the registry says it does. It is the tooltip of every row
 * that has no refusal to state — a right-click entry is a command, so a vague one is fixed in the
 * definition rather than written out again here.
 */
export function entriesWithVerdicts(
  entries: readonly MenuEntry[],
  verdicts: readonly (CommandCheck | undefined)[],
  describes: Readonly<Record<string, string>> = {},
): ResolvedEntry[] {
  return entries.map((entry, index) => {
    if (entry.id === MENU_SEP) {
      return { entry, label: entry.label, separator: true, enabled: false, message: '' };
    }
    const says = describes[entry.id] ?? '';
    if (entry.refused !== undefined) {
      return {
        entry,
        label: `${REFUSED}${entry.label}`,
        separator: false,
        enabled: false,
        message: entry.refused,
      };
    }
    const check = verdicts[index];
    const refused = check?.state === 'refuse';
    return {
      entry,
      label: refused ? `${REFUSED}${entry.label}` : entry.label,
      separator: false,
      enabled: !refused,
      message: check && check.state !== 'undeclared' && check.message ? check.message : says,
    };
  });
}
