import { AreaFlags, Menu, createMenu, type Container, type MenuTemplate } from 'pathux';
import { isLive } from '../../api.js';
import { EDITORS } from '../../../src/shared/editors.js';
import { exec, move, quit, report, toggleMode } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openCommandDialog } from '../dialog.js';
import { openNotifications } from '../notifications.js';
import { openPalette } from '../palette.js';

/** The bar's fixed height. It is locked at both ends, so this is also its minimum. */
export const HEADER_HEIGHT = 34;

/** The last segment of a path. Not `node:path` — this module is in the browser bundle. */
function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Run a menu entry and say what it answered. `report` voices only what the notification push
 * will not — an entry that opens no palette and no dialog would otherwise show nothing at all,
 * and "Cancelled." is the one an entry that opens a chooser most needs to pass on.
 */
function act(id: string): void {
  void exec(id).then(report);
}

/**
 * The app header: the brand (which is also the app menu), the View menu, the project's name,
 * undo/redo, and the badges saying which model, mode and run-mode are live. The React `Topbar`'s
 * three room buttons are not here and will not be: a pane shows an editor, so the nav is a list
 * of editors, and each entry runs the same `view.open` the palette and the agent do.
 *
 * It is a screen area rather than a DOM element above the screen, which is what path.ux's own
 * `MenuBarEditor` is: the mesh then owns the geometry, and a header that is part of the mesh
 * survives the layout round-trip like everything else.
 */
export class VnHeaderEditor extends VnEditor {
  private bar!: Container;
  /** What the bar last drew. Rebuilding on a change beats a widget-per-field push. */
  private drawn = '';

  /** The remembered projects, and the one that is open, as `workspace.recent` last answered. */
  private recents: string[] = [];
  private current = '';
  /** Which project title the list above was fetched for — the guard that keeps it one fetch. */
  private recentsFor = '\0';

  static override define() {
    return {
      tagname: 'vn-header-editor-x',
      areaname: 'header',
      uiname: 'Header',
      icon: -1,
      // No switcher (so `makeHeader` gives a plain row), no collapse, and hidden from the
      // area list: this is chrome, not somewhere the author navigates to.
      flag:
        AreaFlags.HIDDEN |
        AreaFlags.NO_SWITCHER |
        AreaFlags.NO_HEADER_CONTEXT_MENU |
        AreaFlags.NO_COLLAPSE,
    };
  }

  override init() {
    super.init();

    this.borderLock = 1 | 2 | 4 | 8;
    this.areaDragToolEnabled = false;
    this.minSize[1] = this.maxSize[1] = HEADER_HEIGHT;

    this.bar = (this.header as Container).row();
    this.placeNoteArea();
    this.rebuild();
  }

  /** The one header that keeps a note frame — see `VnEditor.wantsNoteArea`. */
  protected override get wantsNoteArea(): boolean {
    return true;
  }

  /**
   * Put the note frame last and hard right, beside the bell that keeps what it shows.
   * `makeHeader` runs inside `super.init()`, so the frame is added before `this.bar` exists and
   * would otherwise sit at the far left, in front of the brand. Re-adding it moves it in the
   * shadow root; the margin goes through `setCSSAfter` because `setBoxCSS` unsets `margin` and
   * rewrites every side from the theme on hover, on press and on every `flushUpdate` — a plain
   * `style['marginLeft']` write is erased moments later.
   */
  private placeNoteArea(): void {
    const notes = this.noteArea;
    if (!notes) return;
    (this.header as Container)._add(notes);
    notes.setCSSAfter(() => (notes.style['marginLeft'] = 'auto'));
  }

  override update() {
    super.update();

    const key = this.stateKey();
    if (key !== this.drawn) this.rebuild();
  }

  /** Every fact the bar draws, in one string. Cheap to compare, and impossible to forget. */
  private stateKey(): string {
    const ui = this.ui;
    return [
      ui.projectTitle,
      ui.model,
      ui.agentMode,
      ui.errors,
      ui.warnings,
      ui.unread,
      ui.canUndo,
      ui.canRedo,
      ui.undoLabel,
      ui.redoLabel,
    ].join('|');
  }

  /**
   * Refetch the remembered projects, once per project the header finds itself in. `workspace.open`
   * is what changes the list, and it also changes the title — so the title is the cheap signal
   * that the list is stale, and the guard is what keeps `rebuild` from fetching forever.
   */
  private refreshRecents(): void {
    const key = this.ui.projectTitle;
    if (this.recentsFor === key) return;
    this.recentsFor = key;

    void exec('workspace.recent').then((outcome) => {
      const data = outcome.ok
        ? (outcome.data as { current?: string; recent?: string[] })
        : undefined;
      this.recents = data?.recent ?? [];
      this.current = data?.current ?? '';
      this.rebuild();
    });
  }

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.refreshRecents();
    const ui = this.ui;

    this.bar.clear();
    this.bar.menu('VN STUDIO', this.appMenu());
    this.bar.menu('View', this.viewMenu());
    this.badge(`project ${ui.projectTitle || '—'}`);

    const undo = this.bar.button('⟲', () => void move('undo'));
    undo.description = ui.undoLabel ? `Undo ${ui.undoLabel}` : 'Nothing to undo';
    undo.disabled = !ui.canUndo;

    const redo = this.bar.button('⟳', () => void move('redo'));
    redo.description = ui.redoLabel ? `Redo ${ui.redoLabel}` : 'Nothing to redo';
    redo.disabled = !ui.canRedo;

    // Errors displace warnings: one count, and the worse one wins it.
    const shown = ui.errors || ui.warnings;
    if (shown > 0) {
      const kind = ui.errors ? 'error' : 'warning';
      this.badge(`${shown} ${kind}${shown === 1 ? '' : 's'}`);
    }

    this.badge(ui.model);
    this.badge(isLive ? 'live' : 'preview');
    this.bar.button(ui.agentMode === 'plan' ? 'PLAN' : 'EXECUTE', () => void toggleMode());

    const bell = this.bar.button(ui.unread ? `🔔 ${ui.unread}` : '🔔', () => openNotifications());
    bell.description = ui.unread
      ? `Show notifications — ${ui.unread} unread`
      : 'Show notifications';

    this.bar.flushUpdate();
  }

  /** A row packs its labels flush, so each one carries its own gutter. */
  private badge(text: string): void {
    this.bar.label(text).style['padding'] = '0px 8px';
  }

  private appMenu(): MenuTemplate {
    return [
      ['Command Palette…', () => openPalette(), '/'],
      Menu.SEP,
      ['Undo', () => void move('undo'), 'Ctrl+Z'],
      ['Redo', () => void move('redo'), 'Ctrl+Shift+Z'],
      Menu.SEP,
      // Not fired from the menu: `pipeline.run` asks before it writes, so the menu opens a dialog
      // on its form. `mock` is seeded from whether this is a live app — a preview has no keys and
      // no main process, and a dry run is the only thing it could honestly do.
      ['Run Pipeline…', () => openCommandDialog('pipeline.run', { mock: !isLive }), undefined],
      // A folder to browse for, a title, and the checkbox that turns the two into a folder the OS
      // chooser could not have named. Checked here rather than in the command, whose own default
      // has always been "the project goes here".
      ['New Project…', () => openCommandDialog('workspace.create', { newFolder: true }), undefined],
      // These two take no argument and ask for no confirmation, so the palette would be an empty
      // form the author dismisses with the same click. They run, and say what they answered — the
      // chooser `workspace.pick` opens is its own confirmation.
      ['Open Project…', () => act('workspace.pick'), undefined],
      this.recentMenu(),
      ['Reindex Project', () => act('workspace.reindex'), undefined],
      // A key is an argument no menu can supply, so this opens the form like the two above. What
      // it collects is written to a gitignored file and recorded as `<secret>`.
      ['Provide Model Key…', () => openCommandDialog('project.setKey'), undefined],
      Menu.SEP,
      // Not fired from the menu either: `upload.pick` is `confirm`, and the dialog is where a
      // command says what it is about to do before the OS chooser takes over the screen.
      ['Upload Files…', () => openCommandDialog('upload.pick'), undefined],
      Menu.SEP,
      ['Plan ⇄ Execute', () => void toggleMode(), 'Shift+Tab'],
      ['Split Area', () => this.ctx.screen.splitTool(), undefined],
      Menu.SEP,
      ['Quit', () => quit(), 'Ctrl+Q'],
    ] as MenuTemplate;
  }

  /**
   * The projects opened before this one, as a submenu of `workspace.open` invocations. Built from
   * `workspace.recent` and from nothing the renderer remembers on its own — a second answer here
   * is how a menu starts offering a project main does not know about.
   *
   * The open project is left out rather than checked: `workspace.open` refuses it by name, and an
   * entry that cannot be taken is worse than one that is not offered.
   */
  private recentMenu(): Menu {
    const others = this.recents.filter((root) => root !== this.current);
    const items = others.length
      ? others.map((root) => [
          projectName(root),
          () => void exec('workspace.open', { path: root }),
          undefined,
          undefined,
          root,
        ])
      : [['(none)', () => {}, undefined]];
    const menu = createMenu(this.ctx, 'Recent Projects', items as MenuTemplate);
    // `createMenu` files its title under the `name` attribute, but the row a parent menu draws for
    // a submenu reads `.title` — so without this the entry is a blank, full-width strip.
    menu.title = 'Recent Projects';
    return menu;
  }

  /**
   * What replaced the room nav: every editor by name, each one a `view.open`. The list is
   * `shared/editors.ts`, which is also what the command's props are built from — a menu that
   * offered something the command would refuse is the drift this avoids.
   */
  private viewMenu(): MenuTemplate {
    const items: MenuTemplate = EDITORS.map((editor) => [
      editor.title,
      () => void exec('view.open', { editor: editor.id }),
      undefined,
    ]) as MenuTemplate;

    return [
      ...items,
      Menu.SEP,
      ['Close Pane', () => void exec('view.close'), undefined],
      ['Reset Layout', () => void exec('view.layout'), undefined],
    ] as MenuTemplate;
  }
}

registerEditor(VnHeaderEditor, 'vn.VnHeaderEditor');
