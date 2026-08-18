/**
 * The app-level keymap. path.ux routes a keystroke to the focused area's keymaps first and
 * falls through to `screen.keymap`, so these are the gestures that belong to the shell rather
 * than to whatever is focused — and an editor that wants `/` for itself can now take it,
 * which the React shell's one window-level `keydown` could not allow.
 *
 * Escape is not here: a popup installs its own handler while it is up, and nothing else in
 * the shell claims it.
 */
import { HotKey, KeyMap } from 'pathux';
import { closeWindow, exec, move, quit, toggleMode } from './bridge.js';
import type { ShellApp } from './context.js';
import { openPalette } from './palette.js';

export function installKeymap(app: ShellApp): void {
  if (!app.screen) return;

  app.screen.keymap = new KeyMap([
    new HotKey('/', [], () => openPalette(), 'Command palette'),
    new HotKey('Z', ['ctrl'], () => void move('undo'), 'Undo'),
    new HotKey('Z', ['ctrl', 'shift'], () => void move('redo'), 'Redo'),
    new HotKey('Y', ['ctrl'], () => void move('redo'), 'Redo'),
    new HotKey('Tab', ['shift'], () => void toggleMode(), 'Plan ⇄ Execute'),
    // Ctrl+Q came with the stock menu, which this app deletes; it belongs to the shell now.
    new HotKey('Q', ['ctrl'], () => void quit(), 'Quit'),
    new HotKey('N', ['ctrl', 'shift'], () => void exec('window.new'), 'New window'),
    new HotKey('W', ['ctrl'], () => void closeWindow(), 'Close window'),
  ]);
}
