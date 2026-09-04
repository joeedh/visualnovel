/**
 * The command palette, an app-level overlay. It is a screen popup rather than something an editor
 * owns, because the palette outlives whichever area happens to be focused.
 *
 * This is the finder: a search box over every command and a list of them, with the chosen one's
 * `CommandForm` underneath. A caller that already knows which command it wants opens
 * `openCommandDialog` instead; the form is the same class either way.
 *
 * The list is the live registry over `command:catalog`, never the generated `commands.json`, so
 * the palette cannot offer a command the app no longer has. Execution goes through `bridge.exec`
 * and so through the same stack CDP and `window.vn` reach.
 */
import { UIBase, type Container, type TextBox } from 'pathux';
import { api } from '../../api.js';
import { filterCommands } from '../../rules/catalog.js';
import type { CatalogEntry, PropValue } from '../../../src/shared/ipc.js';
import type { ProjectVocabulary } from '../../rules/vocabulary.js';
import { shell } from '../app/bridge.js';
import { CommandForm } from '../commands/commandform.js';
import { paragraph } from '../widgets/paragraph.js';
import { INSET, onPopupClosed, popupLeft, stylePopup } from './popup.js';
import { projectChoices, readVocabulary } from '../commands/vocabulary.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 620;
/** What prose may fill, leaving the popup's own inset either side. */
const PROSE = WIDTH - INSET;
const TOP = 56;

let open: Palette | undefined;

class Palette {
  private readonly popup: Popup;
  private readonly listCol: Container;
  private readonly detailCol: Container;
  private search: TextBox | undefined;
  private form: CommandForm | undefined;

  private commands: CatalogEntry[] = [];
  /** The project's own ids, read once when the palette opened. See `vocabulary.ts`. */
  private project: ProjectVocabulary | undefined;
  private query = '';
  /** The command to open on, held until the catalog lands. Re-armed by {@link retarget}. */
  private wanted: { id: string; overrides?: Record<string, PropValue> } | undefined;

  constructor(preselect?: string, overrides?: Record<string, PropValue>) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the palette on');

    const x = popupLeft(screen, WIDTH);
    this.popup = screen.popup(screen as unknown as UIBase, x, TOP, false) as Popup;
    stylePopup(this.popup, screen, WIDTH, TOP);

    // Escape and a click outside never reach `closePalette`, so the `open` guard is cleared when
    // the popup is removed rather than when `close` is called
    onPopupClosed(this.popup, () => {
      open = undefined;
      this.form?.detach();
    });

    const col = this.popup.col();
    const search = col.row();
    search.label('›');
    const box: TextBox = search.textbox(undefined, '', (text: unknown) => {
      this.query = String(text);
      this.renderList();
    });
    // A fixed pixel width pushed the search field past the border on a narrow screen, because the
    // popup itself is capped to the window. The 8px subtracted is the `›` label beside the field,
    // so the field ends on the popup's padding rather than short of it
    box.style['width'] = 'calc(100% - 8px)';
    box.style['maxWidth'] = '100%';
    box.description = 'Narrow the list. Every word you type has to appear in the id or the title.';
    this.search = box;

    this.listCol = col.col();
    this.listCol.style['overflowY'] = 'auto';
    this.listCol.style['maxHeight'] = '360px';
    this.detailCol = col.col();

    if (preselect) this.wanted = { id: preselect, ...(overrides ? { overrides } : {}) };
    void Promise.all([api.invoke('command:catalog'), readVocabulary()]).then(
      ([catalog, project]) => {
        this.commands = catalog.commands;
        this.project = project;
        this.renderList();
        this.openWanted();
      },
    );

    this.popup.flushUpdate();
    box.focus();
  }

  close(): void {
    this.popup.end();
  }

  /**
   * Point a palette that is already up at another command, so a tour can walk several steps through
   * one form without the popup closing and reopening under the author.
   *
   * Naming nothing leaves the palette as the author had it, which is what `view.palette` repeating
   * has to do.
   */
  retarget(preselect?: string, overrides?: Record<string, PropValue>): void {
    if (!preselect) return;
    this.wanted = { id: preselect, ...(overrides ? { overrides } : {}) };
    // The list has to follow the form. A tour stepping the palette from one command to the next
    // otherwise leaves the rows the author last searched for above a form for something else,
    // which reads as the palette having broken rather than moved on.
    this.query = preselect;
    if (this.search) this.search.text = preselect;
    this.renderList();
    this.openWanted();
  }

  /** Open on the command that was asked for, once the catalog has arrived to name it. */
  private openWanted(): void {
    const wanted = this.wanted;
    const entry = wanted && this.commands.find((command) => command.id === wanted.id);
    if (!wanted || !entry) return;
    this.wanted = undefined;
    this.select(entry, wanted.overrides);
    // The constructor focused the search box, but an author who picked this command off a menu
    // wants its first blank field instead
    this.form?.focusFirst();
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
      { onRan: () => this.close(), width: PROSE, choices: projectChoices(entry, this.project) },
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
 *
 * A palette that is already up is pointed at the named command rather than left alone, so a
 * multi-step tour routed through the palette does not have to close and reopen it between steps.
 */
export function openPalette(preselect?: string, overrides?: Record<string, PropValue>): void {
  if (open) return open.retarget(preselect, overrides);
  open = new Palette(preselect, overrides);
}

export function closePalette(): void {
  open?.close();
  open = undefined;
}
