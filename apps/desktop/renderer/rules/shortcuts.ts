/**
 * Every keyboard shortcut the app binds, as one table (`docs/reference/guided-tours.md`, Part
 * III). The shell keymap and the Play pane build their `HotKey`s from it through {@link bindings};
 * the Gen Graph pane's five come from path.ux's own node editor and are copied here with
 * `from: 'pathux'`, which the sweep compares against the live pane. Main's two DevTools
 * accelerators are listed under `main` so the table is complete. Widget-scoped keys (Ctrl+S in a
 * text box, Enter and Escape in an inline editor) are the box's own behaviour and are not listed.
 *
 * A shortcut is a property of the control it duplicates rather than an effect: the derived model
 * stamps `shortcut` on a control record whose first effect an entry matches, and the header's menu
 * rows, the Gen Graph tooltips and the palette button read {@link shortcutOf} for their labels, so
 * a binding is spelled in one place.
 */
import type { keymap } from 'pathux';
import type { Action } from './anchors.js';
import { move, openPopup, view } from './effects.js';
import type { EditorId } from '../../src/shared/editors.js';
import type { UxShortcut } from '../../src/shared/uxmodel.js';

/** A key name as path.ux's `HotKey` takes it. */
export type PathuxKey = keyof typeof keymap;

/** A table key: a path.ux name, or the one key main catches that path.ux has no name for. */
export type ShortcutKey = PathuxKey | 'F12';

/** The modifiers the app binds; the order here is the order a combo is written in. */
export const MODS = ['ctrl', 'shift', 'alt'] as const;
export type ShortcutMod = (typeof MODS)[number];

/** Where a binding is live: the shell, one editor while it has focus, or the main process. */
export type ShortcutScope = 'global' | 'main' | EditorId;

export interface Shortcut {
  scope: ShortcutScope;
  key: ShortcutKey;
  mods: readonly ShortcutMod[];
  /** What the binding is called, which is the `HotKey`'s name and the handler's key. */
  label: string;
  /** What the key does, as the action a control's offer would carry. */
  runs: Action;
  /** Narrows the match to the control keyed with this discriminator, where one id has several. */
  on?: string;
  /** An editor binding that takes a combination the shell also binds; the pane wins while focused. */
  shadows?: true;
  /** A binding copied from path.ux's node editor rather than made here. */
  from?: 'pathux';
}

const command = (id: string): Action => ({ id, props: {} });

/** The table, in the order a combo is looked up: the shell first, then each editor, then main. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    scope: 'global',
    key  : 'P',
    mods : ['ctrl', 'shift'],
    label: 'Command palette',
    runs : openPopup('palette'),
  },
  { scope: 'global', key: 'Z', mods: ['ctrl'], label: 'Undo', runs: move('undo') },
  { scope: 'global', key: 'Z', mods: ['ctrl', 'shift'], label: 'Redo', runs: move('redo') },
  { scope: 'global', key: 'Y', mods: ['ctrl'], label: 'Redo', runs: move('redo') },
  {
    scope: 'global',
    key  : 'Tab',
    mods : ['shift'],
    label: 'Plan ⇄ Execute',
    runs : command('agent.setMode'),
  },
  { scope: 'global', key: 'Q', mods: ['ctrl'], label: 'Quit', runs: command('window.quit') },
  {
    scope: 'global',
    key  : 'N',
    mods : ['ctrl', 'shift'],
    label: 'New window',
    runs : command('window.new'),
  },
  {
    scope: 'global',
    key  : 'W',
    mods : ['ctrl'],
    label: 'Close window',
    runs : command('window.close'),
  },

  { scope: 'play', key: 'Space', mods: [], label: 'Advance', runs: view('step'), on: 'forward' },
  { scope: 'play', key: 'Enter', mods: [], label: 'Advance', runs: view('step'), on: 'forward' },
  { scope: 'play', key: 'Right', mods: [], label: 'Advance', runs: view('step'), on: 'forward' },
  { scope: 'play', key: 'Left', mods: [], label: 'Back', runs: view('step'), on: 'back' },
  { scope: 'play', key: 'Backspace', mods: [], label: 'Back', runs: view('step'), on: 'back' },

  {
    scope: 'gengraph',
    key  : 'Delete',
    mods : [],
    label: 'Delete',
    runs : command('gengraph.removeNode'),
    from : 'pathux',
  },
  {
    scope: 'gengraph',
    key  : 'D',
    mods : ['shift'],
    label: 'Duplicate',
    runs : command('gengraph.duplicateNode'),
    from : 'pathux',
  },
  {
    scope: 'gengraph',
    key  : 'G',
    mods : ['ctrl'],
    label: 'Create Group',
    runs : command('gengraph.createGroup'),
    from : 'pathux',
  },
  {
    scope: 'gengraph',
    key  : 'G',
    mods : ['ctrl', 'alt'],
    label: 'Ungroup',
    runs : command('gengraph.ungroup'),
    from : 'pathux',
  },
  {
    scope: 'gengraph',
    key  : 'Tab',
    mods : [],
    label: 'Edit Group',
    runs : view('scope'),
    on   : 'enter',
    from : 'pathux',
  },

  // Main catches these before the renderer sees them, and DevTools is neither a command nor an
  // effect, so the id is main's own
  { scope: 'main', key: 'F12', mods: [], label: 'Toggle DevTools', runs: command('main.devtools') },
  {
    scope: 'main',
    key  : 'I',
    mods : ['ctrl'],
    label: 'Toggle DevTools',
    runs : command('main.devtools'),
  },
];

/** The combo as the header's rows spell it: `Ctrl+Shift+P`, `Tab`. */
export function comboOf(entry: Pick<Shortcut, 'key' | 'mods'>): string {
  const mods = MODS.filter((mod) => entry.mods.includes(mod)).map(
    (mod) => mod[0]!.toUpperCase() + mod.slice(1),
  );
  return [...mods, entry.key].join('+');
}

/**
 * Whether an entry is the key for what a control does: the same id, the same `on` where the entry
 * names one, and every prop the entry's action names at the same value. Props the entry leaves out
 * are the control's to fill, the way `agent.setMode`'s mode is.
 */
export function matches(
  entry: Shortcut,
  action: { id: string; props?: Readonly<Record<string, unknown>> },
  on?: string,
): boolean {
  if (entry.runs.id !== action.id) return false;
  if (entry.on !== undefined && entry.on !== on) return false;
  const props = action.props ?? {};
  return Object.entries(entry.runs.props).every(([name, value]) => props[name] === value);
}

/**
 * The binding for what a control does, looked up in its editor's scope and the shell's. The whole
 * table when no editor is named, which is how a menu row or a tooltip asks.
 */
export function findShortcut(
  action: { id: string; props?: Readonly<Record<string, unknown>> },
  on?: string,
  editor?: string,
): Shortcut | undefined {
  return SHORTCUTS.find(
    (entry) =>
      (editor === undefined || entry.scope === 'global' || entry.scope === editor) &&
      matches(entry, action, on),
  );
}

/** The combo bound to an action, for a label. Throws when nothing binds it, since a label is a claim. */
export function shortcutOf(action: Action, on?: string): string {
  const found = findShortcut(action, on);
  if (found === undefined) {
    throw new Error(`no shortcut is bound to ${action.id}${on === undefined ? '' : `#${on}`}`);
  }
  return comboOf(found);
}

/** One `HotKey`'s worth: the key, the modifiers, the name and what to run. */
export interface Binding {
  key: PathuxKey;
  mods: readonly ShortcutMod[];
  label: string;
  run: () => void;
}

/**
 * The bindings of one scope, each paired with its handler by label. Throws when an entry has no
 * handler or a handler has no entry, so the pairing cannot drift silently. A `from: 'pathux'`
 * scope is bound by path.ux itself and has no handlers here.
 */
export function bindings(
  scope: ShortcutScope,
  handlers: Readonly<Record<string, () => void>>,
): Binding[] {
  const entries = SHORTCUTS.filter((entry) => entry.scope === scope && entry.from === undefined);
  const labels = new Set(entries.map((entry) => entry.label));
  const unhandled = [...labels].filter((label) => !(label in handlers));
  const unbound = Object.keys(handlers).filter((label) => !labels.has(label));
  if (unhandled.length > 0 || unbound.length > 0) {
    throw new Error(
      `shortcuts in ${scope}: no handler for ${JSON.stringify(unhandled)}, ` +
        `no entry for ${JSON.stringify(unbound)}`,
    );
  }
  // Only main's scope names a key path.ux lacks, and main binds its own rather than calling here
  return entries.map((entry) => ({
    key  : entry.key as PathuxKey,
    mods : entry.mods,
    label: entry.label,
    run  : handlers[entry.label]!,
  }));
}

/** The table as the derived model writes it. */
export function shortcutRecords(): UxShortcut[] {
  return SHORTCUTS.map((entry) => ({
    scope: entry.scope,
    key  : entry.key,
    mods : [...entry.mods],
    label: entry.label,
    runs : { id: entry.runs.id, props: { ...entry.runs.props } },
    ...(entry.on === undefined ? {} : { on: entry.on }),
    ...(entry.shadows === undefined ? {} : { shadows: entry.shadows }),
    ...(entry.from === undefined ? {} : { from: entry.from }),
  }));
}
