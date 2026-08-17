import { AreaFlags, Menu, createMenu, type Container, type MenuTemplate } from 'pathux';
import { isLive } from '../../api.js';
import { EDITOR_IDS, EDITORS, type EditorId } from '../../../src/shared/editors.js';
import { serializeLayoutFile, type LayoutSummary } from '../../../src/shared/layouts.js';
import { exec, move, onInvalidate, quit, report, say, toggleMode } from '../bridge.js';
import type { VnContext } from '../context.js';
import { currentLayoutFile, fetchLayouts } from '../layouts.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openCommandDialog } from '../dialog.js';
import { openNotifications } from '../notifications.js';
import { openPalette } from '../palette.js';
import { openReportDialog } from '../report.js';
import { panesOf } from '../view.js';

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

  /** The project's layout templates, and which one the window is showing. */
  private layouts: LayoutSummary[] = [];
  private activeSlug = '';
  private layoutsFor = '\0';
  /** Bumped whenever the files may have moved, which is what makes the guard above expire. */
  private layoutRevision = 0;
  private unwatch: (() => void) | undefined;

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

    // The Layout submenu is a list of files, so it follows the files rather than the exec feed:
    // a pull, an undo or another window's save all move it without this window running anything.
    this.unwatch = onInvalidate(() => {
      this.layoutRevision++;
      this.rebuild();
    });
    this.rebuild();
  }

  override on_remove() {
    this.unwatch?.();
    this.unwatch = undefined;
    super.on_remove();
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
      this.layoutRevision,
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

  /**
   * Refetch the project's layout templates. Same shape as {@link refreshRecents}, keyed on the
   * project *and* on the revision the invalidate watch bumps — a template is a file, so the
   * things that change the list are writes rather than a change of project.
   */
  private refreshLayouts(): void {
    const key = `${this.ui.projectTitle}|${this.layoutRevision}`;
    if (this.layoutsFor === key) return;
    this.layoutsFor = key;

    void fetchLayouts().then(({ active, layouts }) => {
      this.layouts = layouts;
      this.activeSlug = active;
      this.rebuild();
    });
  }

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.refreshRecents();
    this.refreshLayouts();
    const ui = this.ui;

    this.bar.clear();
    this.bar.menu('VN STUDIO', this.appMenu());
    this.bar.menu('View', this.viewMenu());
    this.bar.menu('Help', this.helpMenu());
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
    const items: MenuTemplate = others.length
      ? others.map((root) => ({
          name: projectName(root),
          callback: () => void exec('workspace.open', { path: root }),
          tooltip: `Close this project and open ${root}`,
          id: root,
        }))
      : [{ name: '(none)', callback: () => {}, tooltip: 'No other project has been opened yet' }];

    return this.submenu('Recent Projects', 'Reopen a project you worked on before', items);
  }

  /**
   * The View menu is two lists and two acts: which editor a pane shows, and how the whole
   * window is arranged. Both are long enough to be submenus — the editor list grows with every
   * port, and the layout list grows with whatever the author saves.
   */
  private viewMenu(): MenuTemplate {
    return [
      this.editorsMenu(),
      this.layoutMenu(),
      Menu.SEP,
      {
        name: 'Close Pane',
        callback: () => void exec('view.close'),
        tooltip: 'Collapse this pane into its neighbour. The last pane is kept.',
      },
      {
        name: 'Split Area',
        callback: () => this.ctx.screen.splitTool(),
        tooltip: 'Drag a line across a pane to divide it in two.',
      },
    ];
  }

  /**
   * One entry, for now. It cannot be a bare `openCommandDialog`: the conversation list is this
   * project's and the model list carries advice, so the dialog is opened by a function that
   * fetches both first.
   */
  private helpMenu(): MenuTemplate {
    return [
      {
        name: 'Report a Difficult Agent…',
        callback: () => void openReportDialog(),
        tooltip:
          'Have a conversation that went wrong read by a debug agent, and draft a bug report ' +
          'from it. Runs on your own model key; names from your story are replaced first.',
      },
    ];
  }

  /**
   * What replaced the room nav: every editor by name, each one a `view.open`. The list is
   * `shared/editors.ts`, which is also what the command's props are built from — a menu that
   * offered something the command would refuse is the drift this avoids.
   */
  private editorsMenu(): Menu {
    return this.submenu(
      'Editors',
      'Show a different editor in this pane',
      EDITORS.map((editor) => ({
        name: editor.title,
        callback: () => void exec('view.open', { editor: editor.id }),
        tooltip: `Show ${editor.what} in this pane`,
        id: editor.id,
      })),
    );
  }

  /**
   * The project's named arrangements, then the two acts that maintain them. A template that
   * cannot be applied is still offered, saying why — `view.applyLayout` refuses it with the same
   * sentence, and an entry silently missing is worse than one that explains itself.
   */
  private layoutMenu(): Menu {
    const rows = this.layouts.map((layout) => ({
      name: layout.slug === this.activeSlug ? `${layout.title} ✓` : layout.title,
      callback: () => void exec('view.applyLayout', { name: layout.slug }),
      tooltip: layout.problem
        ? `Cannot be used: ${layout.problem}`
        : `Rearrange the window: ${layout.description}`,
      id: layout.slug,
    }));

    const items = rows.length
      ? rows
      : [{ name: '(none)', callback: () => {}, tooltip: 'This project has no layouts yet' }];

    return this.submenu('Layout', 'Rearrange the whole window', [
      ...items,
      Menu.SEP,
      {
        name: 'Save Current Layout As…',
        // The dialog collects the name; the mesh it saves is composed here, because only this
        // half can serialize one.
        callback: () => this.saveLayout(),
        tooltip: 'File the arrangement on screen in the project under a name of your own',
      },
      {
        name: 'Reset View Layout…',
        callback: () => openCommandDialog('view.resetLayout'),
        tooltip: 'Put the layouts that ship with the app back the way they shipped — undoable',
      },
    ]);
  }

  /**
   * A submenu row. `createMenu` files its title under the `name` attribute, but the row a parent
   * menu draws for a submenu reads `.title` — so without setting it the entry is a blank,
   * full-width strip.
   */
  private submenu(title: string, tooltip: string, items: MenuTemplate): Menu {
    const menu = createMenu(this.ctx, title, items);
    menu.title = title;
    menu.tooltip = tooltip;
    return menu;
  }

  /**
   * Save what is on screen. The blob is serialized here and handed over as a prop, so main —
   * which has no mesh and no renderer — still owns where the file goes and what it is called.
   *
   * The editor list is read off the mesh here rather than in `layouts.ts`, which would have to
   * import `view.ts` to do it — and `view.ts` imports `layouts.ts`.
   */
  private saveLayout(): void {
    const shell = (this.ctx as VnContext).state;
    const editors = shell.screen
      ? panesOf(shell.screen)
          .filter((pane) => !pane.chrome)
          .map((pane) => pane.editor)
          .filter((id): id is EditorId => (EDITOR_IDS as readonly string[]).includes(id))
      : [];

    const file = currentLayoutFile(shell, editors);
    if (!file) {
      say('This arrangement could not be serialized.', true);
      return;
    }
    openCommandDialog('view.saveLayout', { layout: serializeLayoutFile(file) });
  }
}

registerEditor(VnHeaderEditor, 'vn.VnHeaderEditor');
