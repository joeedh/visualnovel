import { AreaFlags, Menu, createMenu, type Container, type Label, type MenuTemplate } from 'pathux';
import { isLive } from '../../api.js';
import {
  EDITOR_IDS,
  editorTitle,
  editorTooltip,
  OFFERED_EDITOR_IDS,
  type EditorId,
} from '../../../src/shared/editors.js';
import type { PropValue } from '../../../src/shared/ipc.js';
import { serializeLayoutFile, type LayoutSummary } from '../../../src/shared/layouts.js';
import {
  check,
  closeWindow,
  exec,
  move,
  onInvalidate,
  quit,
  report,
  say,
  toggleMode,
} from '../bridge.js';
import { pickPaneToClose } from '../closepane.js';
import type { VnContext } from '../context.js';
import { currentLayoutFile, fetchLayouts } from '../layouts.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openCommandDialog } from '../dialog.js';
import { openDiagnostics } from '../diagnostics.js';
import { openNotifications } from '../notifications.js';
import { openPalette } from '../palette.js';
import { openReportDialog } from '../report.js';
import { paneToUse } from '../panes.js';
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
function act(id: string, props: Record<string, PropValue> = {}): void {
  void exec(id, props).then(report);
}

/**
 * Start a run without a form. Both plain doors — the app menu's entry and the header's button —
 * come through here, so the refusal an author sees is the same sentence whichever they clicked,
 * and it is the command's own: `check` first, because a refused `exec` says nothing a surface
 * can show *before* the work would have started.
 *
 * `mock` follows whether this is a live app: a browser preview has no keys and no main process,
 * and a dry run is the only thing it could honestly do.
 */
function runPipelineNow(): void {
  const props = { mock: !isLive };
  void check('pipeline.run', props).then((verdict) => {
    if (verdict.state === 'refuse') {
      say(verdict.message, true);
      return;
    }
    say(verdict.message || 'Running the pipeline…');
    void exec('pipeline.run', props).then(report);
  });
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

  /** The busy indicator while a run is on, so its tooltip can be retitled without a rebuild. */
  private spinner: Label | undefined;

  /** The remembered projects, and the one that is open, as `workspace.recent` last answered. */
  private recents: string[] = [];
  private current = '';
  /** Which project root the list above was fetched for — the guard that keeps it one fetch. */
  private recentsFor = '\0';

  /** The project's layout templates, and which one the window is showing. */
  private layouts: LayoutSummary[] = [];
  private activeSlug = '';
  private layoutsFor = '\0';
  /** Bumped whenever the files may have moved, which is what makes the guard above expire. */
  private layoutRevision = 0;

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
    const recheck = (): void => {
      this.layoutRevision++;
      this.rebuild();
    };
    this.watch(() => onInvalidate(recheck), recheck);
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
    else this.sayProgress();
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
      ui.busyWhat,
      ui.retryAttempt,
      ui.retryOf,
      this.layoutRevision,
    ].join('|');
  }

  /**
   * Refetch the remembered projects, once per project the header finds itself in. `workspace.open`
   * is what changes the list, and it also changes which root is open — so the root is the cheap
   * signal that the list is stale, and the guard is what keeps `rebuild` from fetching forever.
   */
  private refreshRecents(): void {
    // Keyed on the root, not the title: two projects may be called the same thing, and the list
    // the second one showed would then be the first one's, forever.
    const key = this.ui.projectRoot;
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
    this.bar.menu('VN STUDIO', this.appMenu()).description =
      'Open, create and export a project, and everything that acts on the workspace as a whole.';
    this.bar.menu('View', this.viewMenu()).description =
      'Split and close panes, and switch between the saved window layouts.';
    this.bar.menu('Help', this.helpMenu()).description =
      'The docs, and what to do about an agent that misbehaved.';
    this.badge(`project ${ui.projectTitle || '—'}`, true);
    this.runControls();

    const undo = this.bar.button('⟲', () => void move('undo'));
    undo.description = ui.undoLabel ? `Undo ${ui.undoLabel}` : 'Nothing to undo';
    undo.disabled = !ui.canUndo;

    const redo = this.bar.button('⟳', () => void move('redo'));
    redo.description = ui.redoLabel ? `Redo ${ui.redoLabel}` : 'Nothing to redo';
    redo.disabled = !ui.canRedo;

    // Errors displace warnings: one count, and the worse one wins it. A button rather than a
    // label, because a count with no way to ask *which* is a number the author cannot act on.
    const shown = ui.errors || ui.warnings;
    if (shown > 0) {
      const kind = ui.errors ? 'error' : 'warning';
      const problems = this.bar.button(`${shown} ${kind}${shown === 1 ? '' : 's'}`, () =>
        openDiagnostics(),
      );
      problems.description =
        ui.errors && ui.warnings
          ? `List them — ${ui.errors} error${ui.errors === 1 ? '' : 's'} and ` +
            `${ui.warnings} warning${ui.warnings === 1 ? '' : 's'} in this project`
          : 'List what validation says is wrong with this project';
    }

    this.badge(ui.model, false, 'current agent model - set in convo tab');
    this.retryBadge();
    this.badge(
      isLive ? 'live' : 'preview',
      false,
      isLive
        ? 'A real run: this window can call models and write assets'
        : 'A browser preview: every run is a dry run, and no model is called',
    );
    const mode = this.bar.button(
      ui.agentMode === 'plan' ? 'PLAN' : 'EXECUTE',
      () => void toggleMode(),
    );
    mode.description =
      ui.agentMode === 'plan'
        ? 'Plan mode: the agent reads but never writes. Click to let it apply edits.'
        : 'Execute mode: the agent may apply edits. Click to make it read-only again.';

    const bell = this.bar.button(ui.unread ? `🔔 ${ui.unread}` : '🔔', () => openNotifications());
    bell.description = ui.unread
      ? `Show notifications — ${ui.unread} unread`
      : 'Show notifications';

    this.bar.flushUpdate();
  }

  /**
   * The run button, and — only while one is running — the spinner and the stop button. All three
   * read `ui.busy*`, which main pushes on both edges of the work and on every task between, so
   * none of them keeps a flag of its own that a crashed run could leave set.
   */
  private runControls(): void {
    const busy = this.ui.busyWhat;

    const run = this.bar.button('▶ Run', () => runPipelineNow());
    run.disabled = busy !== '';
    run.description = busy
      ? `Cannot start: ${busy} is already in progress.`
      : isLive
        ? 'Plan and render everything that is ready, to the next gate'
        : 'Preview what a run would do. This window cannot call a model.';

    this.spinner = undefined;
    if (busy !== 'a pipeline run') return;

    const spinner = this.bar.label('◴');
    this.spinner = spinner;
    this.sayProgress();
    // Turned by the Web Animations API rather than a `@keyframes` rule: keyframe names are looked
    // up in the element's own tree scope, and this label sits several nested shadow roots below
    // the one `adoptStyle` reaches. `setCSSAfter` for the box, which the theme rewrites each pass.
    spinner.setCSSAfter(() => {
      spinner.style['padding'] = '0px 8px';
      spinner.style['display'] = 'inline-block';
    });
    spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: 1600,
      iterations: Infinity,
    });

    const stop = this.bar.button('■', () => void exec('pipeline.stop').then(report));
    stop.description = 'Stop the run after the task it is on. Finished work is kept.';
    stop.setCSSAfter(() => (stop.style['color'] = 'var(--vermilion, #e5534b)'));
  }

  /**
   * The retry counter, beside the model it is retrying. Drawn only while a retry is actually in
   * hand — which is what makes it a badge rather than a control: there is nothing to click,
   * because the author already answered the card that started it, and the way to end it early is
   * the Stop button the turn already has.
   */
  private retryBadge(): void {
    const ui = this.ui;
    if (ui.retryAttempt < 1) return;
    this.badge(
      `⟳ retry ${ui.retryAttempt}/${ui.retryOf}`,
      false,
      `The model call failed and is being tried again — attempt ${ui.retryAttempt} of ` +
        `${ui.retryOf}. The turn carries on from where it was if one succeeds, and stops if ` +
        `none of them do.`,
    );
  }

  /**
   * Retitle the spinner from the counts. Deliberately not part of {@link stateKey}: a task
   * finishing would then rebuild the whole bar, and the rotation would restart from zero every
   * few seconds — the one thing a busy indicator must not do.
   */
  private sayProgress(): void {
    const ui = this.ui;
    if (!this.spinner) return;
    const left = ui.busyPending;
    this.spinner.description =
      `The pipeline is running — ${ui.busyRan} task(s) done, ` +
      `${left} ${left === 1 ? 'task' : 'tasks'} left.`;
  }

  /** A row packs its labels flush, so each one carries its own gutter. */
  private badge(text: string, outlined = false, tooltip?: string): void {
    const label = this.bar.label(text);
    if (tooltip) label.description = tooltip;
    // `setCSSAfter` for the outline for the same reason the note frame's margin needs it: the box
    // is rewritten from the theme on every `flushUpdate`, which drops a plain border write.
    if (outlined) {
      label.setCSSAfter(() => {
        label.style['padding'] = '1px 10px';
        label.style['border'] = '1px solid var(--vn-badge-border, rgba(255,255,255,0.35))';
        label.style['borderRadius'] = '10px';
      });
      return;
    }
    label.style['padding'] = '0px 8px';
  }

  /**
   * The app menu. Every entry is written in **object** form, because the array form has no slot
   * for a tooltip — an entry that will not say what it does is the same unfinished control a
   * button without one is, and half this menu opens a dialog the author cannot preview.
   */
  private appMenu(): MenuTemplate {
    return [
      {
        name: 'Command Palette…',
        callback: () => openPalette(),
        hotkey: '/',
        tooltip: 'Search every command by name and fill in its arguments',
      },
      Menu.SEP,
      {
        name: 'Undo',
        callback: () => void move('undo'),
        hotkey: 'Ctrl+Z',
        tooltip: 'Put the project back the way it was before the last act',
      },
      {
        name: 'Redo',
        callback: () => void move('redo'),
        hotkey: 'Ctrl+Shift+Z',
        tooltip: 'Reapply the act that was just undone',
      },
      Menu.SEP,
      // Fired, not formed: the plain entry and the header's button are one door, and neither asks
      // a question. `runPipelineNow` checks first so a refusal is shown before anything starts.
      {
        name: 'Run Pipeline',
        callback: () => runPipelineNow(),
        tooltip: 'Plan and render everything that is ready, to the next gate',
      },
      // The advanced door: `pipeline.run`'s own form, where the flags live. `mock` is seeded from
      // whether this is a live app — a preview has no keys, and a dry run is all it could do.
      {
        name: 'Run Pipeline (adv)…',
        callback: () => openCommandDialog('pipeline.run', { mock: !isLive }),
        tooltip: 'Start a run with the flags spelled out — dry run, scene filter, task limit',
      },
      // A folder to browse for, a title, and the checkbox that turns the two into a folder the OS
      // chooser could not have named. Checked here rather than in the command, whose own default
      // has always been "the project goes here".
      {
        name: 'New Project…',
        callback: () => openCommandDialog('workspace.create', { newFolder: true }),
        tooltip: 'Scaffold a project in a new folder and open it, closing this one',
      },
      // These two take no argument and ask for no confirmation, so the palette would be an empty
      // form the author dismisses with the same click. They run, and say what they answered — the
      // chooser `workspace.pick` opens is its own confirmation.
      {
        name: 'Open Project…',
        callback: () => act('workspace.pick'),
        tooltip: 'Choose a project folder and open it, closing this one',
      },
      this.recentMenu(),
      {
        name: 'Reindex Project',
        callback: () => act('workspace.reindex'),
        tooltip: 'Rebuild the map the authoring agent reads: cast, locations, story graph, bible',
      },
      // The Setup pane rather than `project.setKey`'s bare form: a box asking for a credential is
      // no use to someone who does not yet have one, and the pane is the same box with the steps
      // for getting there above it. The form is still in the palette for anyone who just wants it.
      {
        name: 'Set Up API Keys…',
        callback: () => act('view.open', { editor: 'onboarding', where: 'elsewhere' }),
        tooltip: 'How to get a model key, which of yours are set, and where they are read from',
      },
      Menu.SEP,
      // Not fired from the menu either: `upload.pick` is `confirm`, and the dialog is where a
      // command says what it is about to do before the OS chooser takes over the screen.
      {
        name: 'Upload Files…',
        callback: () => openCommandDialog('upload.pick'),
        tooltip: 'Copy files into the project archive, verbatim, under a dated folder',
      },
      Menu.SEP,
      {
        name: 'Plan ⇄ Execute',
        callback: () => void toggleMode(),
        hotkey: 'Shift+Tab',
        tooltip: 'Switch the agent between reading only and being allowed to apply edits',
      },
      Menu.SEP,
      {
        name: 'Quit',
        callback: () => void quit(),
        hotkey: 'Ctrl+Q',
        tooltip: 'Close every window and quit vnstudio',
      },
    ];
  }

  /**
   * The projects this install has opened, as a submenu of `workspace.open` invocations. Built from
   * `workspace.recent` and from nothing the renderer remembers on its own — a second answer here
   * is how a menu starts offering a project main does not know about.
   *
   * The open one is **kept**, ticked and inert. Dropping it read as the bug it caused: a list of
   * one project renders `(none)`, which is a menu that looks empty and is telling the truth.
   */
  private recentMenu(): Menu {
    const items: MenuTemplate = this.recents.length
      ? this.recents.map((root) => {
          const open = root === this.current;
          return {
            name: open ? `${projectName(root)} ✓` : projectName(root),
            callback: open ? () => {} : () => void exec('workspace.open', { path: root }),
            tooltip: open
              ? `${root} is the project you have open`
              : `Close this project and open ${root}`,
            id: root,
          };
        })
      : [{ name: '(none)', callback: () => {}, tooltip: 'No project has been opened yet' }];

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
      // Both are gestures rather than commands: which pane, and where the line falls, are answers
      // only a pointer can give. `view.close` still exists for the palette, the agent and CDP,
      // where there is no pointer and the active pane is the only pane that can be meant.
      {
        name: 'Close Pane…',
        callback: () => this.closePane(),
        tooltip: 'Point at a pane to close it — it is outlined and crossed out. Escape cancels.',
      },
      {
        name: 'Split Area',
        callback: () => this.ctx.screen.splitTool(),
        tooltip: 'Drag a line across a pane to divide it in two.',
      },
      Menu.SEP,
      // A window is the fourth way to divide the screen, and it belongs beside the other three
      // rather than in a menu of its own — an author reaching for "put this on the other
      // monitor" is looking where they look for a split.
      {
        name: 'New Window',
        callback: () => void exec('window.new'),
        hotkey: 'Ctrl+Shift+N',
        tooltip: 'Open another window onto this project — one app, panes across two monitors',
      },
      {
        name: 'Close Window',
        callback: () => void closeWindow(),
        hotkey: 'Ctrl+W',
        tooltip: 'Close this window; closing the last one quits',
      },
      {
        name: 'Move Pane to New Window',
        callback: () => void this.movePaneToWindow(),
        tooltip: 'Reopen the active pane’s editor in a window of its own and close it here',
      },
    ];
  }

  /**
   * Two invocations rather than one command, on purpose: "move" is only ever `window.new` and
   * then `view.close`, and a third command that did both would be a third thing to keep honest.
   * The close comes second and only if the window opened, so a refused open leaves the pane.
   */
  private async movePaneToWindow(): Promise<void> {
    const screen = (this.ctx as VnContext).state.screen;
    const pane = screen ? panesOf(screen)[paneToUse(panesOf(screen))] : undefined;
    if (!pane || !pane.editor) {
      say('There is no pane to move.', true);
      return;
    }

    const opened = await exec('window.new', { editor: pane.editor });
    report(opened);
    if (opened.ok) report(await exec('view.close'));
  }

  /** Hand the pick a live mesh, or say why there is nothing to point at. */
  private closePane(): void {
    const screen = (this.ctx as VnContext).state.screen;
    if (!screen) {
      say('There is no window to close a pane in.', true);
      return;
    }
    pickPaneToClose(screen, say);
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
   * What replaced the room nav: every editor an author browses to, each one a `view.open`. The
   * list is `shared/editors.ts`, which is also what the command's props are built from — a menu
   * that offered something the command would refuse is the drift this avoids.
   *
   * `OFFERED_EDITOR_IDS` rather than `EDITORS`, and it is the same predicate the shell hands
   * path.ux's own area menu: an editor reached from one place and one place only is listed in
   * neither switcher. `view.open` still takes its name, so the entry that does reach it works.
   */
  private editorsMenu(): Menu {
    return this.submenu(
      'Editors',
      'Show a different editor in this pane',
      OFFERED_EDITOR_IDS.map((id) => ({
        name: editorTitle(id),
        callback: () => void exec('view.open', { editor: id }),
        tooltip: editorTooltip(id),
        id,
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
