/**
 * The command palette, as an app-level overlay: a screen popup rather than anything an editor
 * owns, because the palette outlives whichever area happens to be focused.
 *
 * This is the **finder** — a search box over every command and a list of them, with the chosen
 * one's `CommandForm` underneath. A caller that already knows which command it wants opens
 * `openCommandDialog` instead; the form is the same class either way.
 *
 * The list is the **live** registry over `command:catalog`, never the generated `commands.json`,
 * so the palette cannot offer a command the app no longer has; execution goes through
 * `bridge.exec` and so through the same stack CDP and `window.vn` reach.
 */
import { UIBase, type Container, type TextBox } from 'pathux';
import { api } from '../api.js';
import { filterCommands } from '../rules/catalog.js';
import type { CatalogEntry, PropValue } from '../../src/shared/ipc.js';
import { shell } from './bridge.js';
import { CommandForm } from './commandform.js';
import { paragraph } from './paragraph.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 620;
/** What prose may fill, leaving the popup's own inset either side. */
const PROSE = WIDTH - 24;
const TOP = 56;

let open: Palette | undefined;

class Palette {
  private readonly popup: Popup;
  private readonly listCol: Container;
  private readonly detailCol: Container;
  private form: CommandForm | undefined;

  private commands: CatalogEntry[] = [];
  private query = '';

  constructor(preselect?: string, overrides?: Record<string, PropValue>) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the palette on');

    const x = Math.max(8, Math.round(screen.size[0] / 2 - WIDTH / 2));
    this.popup = screen.popup(screen as unknown as UIBase, x, TOP, false) as Popup;
    this.popup.style['width'] = `${WIDTH}px`;

    // Escape and a click outside both go straight to the popup's own `end`, so the module's
    // idea of what is open has to hang off that rather than off `closePalette`.
    const end = this.popup.end.bind(this.popup);
    this.popup.end = () => {
      open = undefined;
      this.form?.detach();
      end();
    };

    const col = this.popup.col();
    const search = col.row();
    search.label('›');
    const box: TextBox = search.textbox(undefined, '', (text: unknown) => {
      this.query = String(text);
      this.renderList();
    });
    box.style['width'] = `${WIDTH - 60}px`;

    this.listCol = col.col();
    this.listCol.style['overflowY'] = 'auto';
    this.listCol.style['maxHeight'] = '360px';
    this.detailCol = col.col();

    void api.invoke('command:catalog').then((catalog) => {
      this.commands = catalog.commands;
      this.renderList();

      const entry = catalog.commands.find((c) => c.id === preselect);
      if (!entry) return;
      this.select(entry, overrides);
      // The search box has the focus the constructor gave it, and the author who picked this
      // command off a menu is not searching for it — they are here to fill its first blank.
      this.form?.focusFirst();
    });

    this.popup.flushUpdate();
    box.focus();
  }

  close(): void {
    this.popup.end();
  }

  private renderList(): void {
    this.listCol.clear();
    const shown = filterCommands(this.commands, this.query);
    this.listCol.label(`COMMANDS · ${shown.length}`);

    for (const entry of shown) {
      const label = `${entry.id}${entry.mutating ? ' ✎' : ''} — ${entry.title}`;
      const button = this.listCol.button(label, () => this.select(entry));
      button.description = entry.description;
    }

    this.listCol.flushUpdate();
  }

  /**
   * Highlighting a row is not running it. Selecting arms the precondition, so the verdict is
   * there to read before the click that runs the command.
   */
  private select(entry: CatalogEntry, overrides?: Record<string, PropValue>): void {
    this.form?.detach();

    this.detailCol.clear();
    this.detailCol.label(entry.id);
    paragraph(this.detailCol, entry.description, PROSE);

    this.form = new CommandForm(
      this.detailCol.col(),
      entry,
      { onRan: () => this.close(), width: PROSE },
      overrides,
    );
    this.form.render();
    void this.form.recheck();
    this.detailCol.flushUpdate();
  }
}

/**
 * Open the palette. Idempotent — `view.palette` may repeat. `preselect` still works and is what
 * `command:ui` uses; a caller naming a command from a menu wants `openCommandDialog`.
 */
export function openPalette(preselect?: string, overrides?: Record<string, PropValue>): void {
  if (open) return;
  open = new Palette(preselect, overrides);
}

export function closePalette(): void {
  open?.close();
  open = undefined;
}
