/**
 * The command palette, as an app-level overlay: a screen popup rather than anything an editor
 * owns, because the palette outlives whichever area happens to be focused.
 *
 * The list is the **live** registry over `command:catalog`, never the generated
 * `commands.json`, so the palette cannot offer a command the app no longer has; execution goes
 * through `bridge.exec` and so through the same stack CDP and `window.vn` reach. The matching,
 * the blank-value rules and the field coercion are `app/catalog.ts` unchanged — that half was
 * always framework-free, and two palettes disagreeing about which command a query names would
 * be a bug in both.
 */
import { UIBase, type Container, type MenuTemplateCustom } from 'pathux';
import { api } from '../api.js';
import { blankProps, fieldText, fieldValue, filterCommands } from '../rules/catalog.js';
import type { CatalogEntry, CatalogProp, CommandCheck, PropValue } from '../../src/shared/ipc.js';
import { exec, say, shell } from './bridge.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 620;
const TOP = 56;

let open: Palette | undefined;

class Palette {
  private readonly popup: Popup;
  private readonly listCol: Container;
  private readonly detailCol: Container;

  private commands: CatalogEntry[] = [];
  private query = '';
  private chosen: CatalogEntry | undefined;
  private values: Record<string, PropValue> = {};
  private check: CommandCheck | undefined;
  /** A `confirm: true` command needs a second click, and the button says so between them. */
  private confirming = false;

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
      end();
    };

    const col = this.popup.col();
    const search = col.row();
    search.label('›');
    const box = search.textbox(undefined, '', (text: unknown) => {
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
      this.select(entry);
      if (overrides) {
        Object.assign(this.values, overrides);
        this.renderDetail();
        void this.recheck();
      }
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
  private select(entry: CatalogEntry): void {
    this.chosen = entry;
    this.values = blankProps(entry);
    this.check = undefined;
    this.confirming = false;
    this.renderDetail();
    void this.recheck();
  }

  private async recheck(): Promise<void> {
    const entry = this.chosen;
    if (!entry?.checkable) return;
    const check = await api.invoke('command:check', { id: entry.id, props: this.values });
    // A newer selection may have landed while this was in flight; its answer wins.
    if (this.chosen !== entry) return;
    this.check = check;
    this.renderDetail();
  }

  private renderDetail(): void {
    this.detailCol.clear();
    const entry = this.chosen;
    if (!entry) return;

    this.detailCol.label(entry.id);
    this.detailCol.label(entry.description);

    for (const prop of entry.props) this.field(prop);

    // `undeclared` renders as nothing at all: a command that states no precondition has not
    // said yes, and a tick here would invent an assurance.
    if (this.check && this.check.state !== 'undeclared') {
      this.detailCol.label(`${this.check.state === 'accept' ? '✓' : '✕'} ${this.check.message}`);
    }

    const run = this.detailCol.button(this.confirming ? 'confirm — run it' : 'run', () => {
      void this.run(entry);
    });
    run.description = entry.confirm ? 'this command asks before it writes' : entry.title;

    this.detailCol.flushUpdate();
  }

  /** One declared prop as an editable widget. `coerceProps` in main stays the authority. */
  private field(prop: CatalogProp): void {
    const row = this.detailCol.row();
    row.label(`${prop.name}${prop.required ? ' *' : ''}`);
    const value = this.values[prop.name];

    if (prop.kind === 'boolean') {
      // A button rather than a checkbox: the label carries the state, so the form reads the
      // same whether or not the widget has focus.
      row.button(value ? 'yes' : 'no', () => {
        this.values[prop.name] = !value;
        this.renderDetail();
        void this.recheck();
      });
      return;
    }

    if (prop.kind === 'enum') {
      row.menu(
        String(value ?? ''),
        (prop.values ?? []).map(
          (option): MenuTemplateCustom => [
            option,
            () => {
              this.values[prop.name] = option;
              this.renderDetail();
              void this.recheck();
            },
          ],
        ),
      );
      return;
    }

    const box = row.textbox(undefined, fieldText(value ?? ''), (text: unknown) => {
      this.values[prop.name] = fieldValue(prop, String(text));
      void this.recheck();
    });
    box.description = prop.description;
  }

  private async run(entry: CatalogEntry): Promise<void> {
    if (entry.confirm && !this.confirming) {
      this.confirming = true;
      this.renderDetail();
      return;
    }
    this.confirming = false;

    const outcome = await exec(entry.id, this.values);
    if (outcome.ok) {
      say(outcome.record.message);
      this.close();
    } else {
      // The refusal already went to the note frame; the palette stays up so it can be edited.
      void this.recheck();
    }
  }
}

/**
 * Open the palette. Idempotent — `view.palette` may repeat. A menu item that names a command
 * passes it (with any prop overrides) so the palette opens on its form: the invocation is still
 * read and confirmed before it runs, rather than fired from a menu with props nobody saw.
 */
export function openPalette(preselect?: string, overrides?: Record<string, PropValue>): void {
  if (open) return;
  open = new Palette(preselect, overrides);
}

export function closePalette(): void {
  open?.close();
  open = undefined;
}
