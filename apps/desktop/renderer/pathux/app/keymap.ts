/**
 * The app-level keymap. path.ux routes a keystroke to the focused area's keymaps first and
 * falls through to `screen.keymap`, so these are the gestures that belong to the shell rather
 * than to the focused editor. The keys themselves are the `global` rows of `rules/shortcuts.ts`;
 * this file supplies what each runs.
 *
 * Escape is not here: a popup installs its own handler while it is up, and nothing else in
 * the shell claims it.
 */
import { HotKey, KeyMap } from 'pathux';
import { closeWindow, exec, move, quit, report, toggleMode } from './bridge.js';
import type { ShellApp } from './context.js';
import { openPalette } from '../chrome/palette.js';
import { bindings, type ShortcutScope } from '../../rules/shortcuts.js';
import { watchKeymap } from '../tour/anchors.js';

/** The `HotKey`s of one scope, each running the handler its table row names. */
export function hotkeys(
  scope: ShortcutScope,
  handlers: Readonly<Record<string, () => void>>,
): HotKey[] {
  return bindings(scope, handlers).map(
    (binding) => new HotKey(binding.key, [...binding.mods], binding.run, binding.label),
  );
}

export function installKeymap(app: ShellApp): void {
  const screen = app.screen;
  if (!screen) return;

  screen.keymap = new KeyMap(
    hotkeys('global', {
      'Command palette': () => openPalette(),
      Undo             : () => void move('undo'),
      Redo             : () => void move('redo'),
      'Plan ⇄ Execute' : () => void toggleMode(),
      // Ctrl+Q came with the stock menu, which this app deletes; it belongs to the shell now.
      Quit             : () => void quit(),
      'New window'     : () => void exec('window.new'),
      'Close window'   : () => void closeWindow(),
      'Save all'       : () => void exec('doc.saveAll'),
      'Zoom in'        : () => void exec('view.zoom', { move: 'in' }).then(report),
      'Zoom out'       : () => void exec('view.zoom', { move: 'out' }).then(report),
      'Reset zoom'     : () => void exec('view.zoom', { move: 'reset' }).then(report),
    }),
  );
  watchKeymap('global', () => screen.keymap);
}
