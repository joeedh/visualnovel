/**
 * One command as its own dialog: a heading, what it does, its fields, its verdict, Cancel and the
 * button that runs it.
 *
 * The palette is a *finder* — a search box over every command and a scrolling list of them — and
 * an author who picked an entry off a menu has already found the command. What they need is the
 * form. It is the same `CommandForm` the palette hosts, so nothing about a field or a verdict is
 * decided twice.
 */
import { UIBase, type Container } from 'pathux';
import { api } from '../api.js';
import type { PropValue } from '../../src/shared/ipc.js';
import { shell } from './bridge.js';
import { CommandForm, type Choices } from './commandform.js';
import { paragraph } from './paragraph.js';
import { INSET, onPopupClosed, popupLeft, stylePopup } from './popup.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 520;
/** What prose may fill, leaving the popup's own inset either side. */
const PROSE = WIDTH - INSET;

let open: Dialog | undefined;

class Dialog {
  private readonly popup: Popup;
  private readonly body: Container;
  private form: CommandForm | undefined;

  constructor(id: string, overrides?: Record<string, PropValue>, choices?: Choices) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang a dialog on');

    const x = popupLeft(screen, WIDTH);
    const y = Math.max(56, Math.round(screen.size[1] * 0.22));
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
    stylePopup(this.popup, screen, WIDTH, y);

    onPopupClosed(this.popup, () => {
      open = undefined;
      this.form?.detach();
    });

    this.body = this.popup.col();

    void api.invoke('command:catalog').then((catalog) => {
      const entry = catalog.commands.find((c) => c.id === id);
      if (!entry) {
        this.body.label(`No command called ${id}.`);
        this.body.flushUpdate();
        return;
      }

      const heading = this.body.label(entry.title);
      heading.description = entry.id;
      const what = paragraph(this.body, entry.description, PROSE);
      what.description = entry.description;

      this.form = new CommandForm(
        this.body.col(),
        entry,
        {
          onRan: () => this.close(),
          runLabel: entry.title,
          buttons: (row) => {
            const cancel = row.button('Cancel', () => this.close());
            cancel.description = 'Close this without running anything';
          },
          choices,
          width: PROSE,
        },
        overrides,
      );
      this.form.render();
      void this.form.recheck();
      this.body.flushUpdate();
      this.form.focusFirst();
    });

    this.popup.flushUpdate();
  }

  close(): void {
    this.popup.end();
  }
}

/**
 * Open a dialog on one command. Idempotent, like the palette — a menu entry clicked twice is one
 * dialog. Escape and a click outside close it, and so does Cancel.
 *
 * `choices` offers option lists for this opening only, for the fields whose vocabulary belongs to
 * the project rather than to the command — the conversations in it, the models a key is set for.
 */
export function openCommandDialog(
  id: string,
  overrides?: Record<string, PropValue>,
  choices?: Choices,
): void {
  if (open) return;
  open = new Dialog(id, overrides, choices);
}

export function closeCommandDialog(): void {
  open?.close();
  open = undefined;
}
