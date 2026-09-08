import { AreaFlags, type Container, type Label, type MenuTemplate, type ScreenArea } from 'pathux';
import { TEXT_MODELS } from '@vn/types';
import { isLive } from '../../api.js';
import { EDITOR_IDS, type EditorId } from '../../../src/shared/editors.js';
import type { PropValue } from '../../../src/shared/ipc.js';
import { busyControls, type BusyControls } from '../../rules/busy.js';
import { HEADER } from '../../rules/anchors.js';
import {
  approvalsAction,
  modeAction,
  modelAction,
  notificationsAction,
  problemsAction,
  runAction,
  stopAction,
  viewActions,
} from '../../rules/headerbar.js';
import {
  HEADER_MENUS,
  type HandledKey,
  type HeaderMenu,
  type HeaderMenuState,
} from '../../rules/headermenus.js';
import { redrawing, type AnchorPass } from '../tour/anchors.js';
import { serializeLayoutFile, type LayoutSummary } from '../../../src/shared/layouts.js';
import { check, exec, move, onInvalidate, report, say, setMode, setModel } from '../app/bridge.js';
import { pickPaneToClose } from '../panes/closepane.js';
import type { VnContext } from '../app/context.js';
import { currentLayoutFile, fetchLayouts } from '../panes/layouts.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { openDiagnostics } from '../chrome/diagnostics.js';
import { openApprovals } from '../chrome/approvals.js';
import { openNotifications } from '../chrome/notifications.js';
import { rectOf } from '../chrome/popup.js';
import { openPalette } from '../chrome/palette.js';
import { buildMenu, type MenuHandler } from '../chrome/showmenu.js';
import { seedReport } from '../agent/reportconvo.js';
import { NO_PANE, paneToUse } from '../panes/panes.js';
import { panesOf } from '../panes/view.js';
import type { GenGraphEditor } from './nodes.js';

/** What the Edit menu's group entries ask of a Gen Graph pane. Type-only, so no import cycle. */
type GroupActions = Pick<
  GenGraphEditor,
  'groupSelected' | 'ungroupSelected' | 'enterGroup' | 'exitGroup'
>;

/** The bar's fixed height. It is locked at both ends, so this is also its minimum. */
export const HEADER_HEIGHT = 34;

/**
 * Start a run without a form. `check` runs first, because a refused `exec` says nothing a surface
 * can show before the work would have started. The props come from `runAction`, which the app
 * menu's Run Pipeline row reads too, so the button and the row cannot differ about what a run is.
 */
function runPipelineNow(props: Record<string, PropValue>): void {
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
 * three room buttons are deliberately absent: a pane shows an editor, so the nav is a list of
 * editors, and each entry runs the same `view.open` the palette and the agent do.
 *
 * The header is a screen area rather than a DOM element above the screen (path.ux's own
 * `MenuBarEditor` is a DOM element above the screen). The mesh therefore owns the geometry, and
 * a header that is part of the mesh survives the layout round-trip like everything else.
 */
export class VnHeaderEditor extends VnEditor {
  private bar!: Container;
  private anchors: AnchorPass = redrawing(HEADER, 'bar');
  /** What the bar last drew. Rebuilding on a change beats a widget-per-field push. */
  private drawn = '';

  /** The busy indicator while a run is on, so its tooltip can be retitled without a rebuild. */
  private spinner: Label | undefined;
  /** What the work in flight draws, kept so the spinner can be retitled from the same table. */
  private controls: BusyControls | undefined;

  /** The remembered projects, and the one that is open, as `workspace.recent` last answered. */
  private recents: string[] = [];
  private current = '';
  /** Which project root the recents were fetched for, so the fetch happens once per project. */
  private recentsFor = '\0';

  /** The project's layout templates, and which one the window is showing. */
  private layouts: LayoutSummary[] = [];
  private activeSlug = '';
  private layoutsFor = '\0';
  /** Bumped whenever the layout files may have moved, which expires `layoutsFor`. */
  private layoutRevision = 0;

  /** Whether this project carries the GitHub page builder, which decides one menu label. */
  private pagesInstalled = false;
  private pagesFor = '\0';

  /**
   * What runs each menu row the header handles itself: the effects, and the two commands whose
   * props the active Gen Graph pane supplies. Typed over `HANDLED`, so a row the menus add is a
   * compile error here until it is handled.
   */
  private readonly handlers: Record<HandledKey, MenuHandler> = {
    'popup.open'          : () => openPalette(),
    'history.move'        : (props) => void move(props['to'] === 'redo' ? 'redo' : 'undo'),
    'screen.arrange': (props) => (props['what'] === 'split' ? this.splitArea() : this.closePane()),
    'pane.view#enter'     : () => this.withGenGraph((pane) => pane.enterGroup()),
    'pane.view#exit'      : () => this.withGenGraph((pane) => pane.exitGroup()),
    'gengraph.createGroup': () => this.withGenGraph((pane) => void pane.groupSelected()),
    'gengraph.ungroup'    : () => this.withGenGraph((pane) => void pane.ungroupSelected()),
    'view.open#report'    : () => void seedReport(),
    'agent.setMode'       : (props) => void setMode(String(props['mode'] ?? '')),
  };

  static override define() {
    return {
      tagname : 'vn-header-editor-x',
      areaname: 'header',
      uiname  : 'Header',
      icon    : -1,
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
   * Put the note frame last and hard right, beside the bell, which keeps what the frame shows.
   * `makeHeader` runs inside `super.init()`, so the frame is added before `this.bar` exists and
   * would otherwise sit at the far left, in front of the brand. Re-adding it moves it in the
   * shadow root. The margin goes through `setCSSAfter` because `setBoxCSS` unsets `margin` and
   * rewrites every side from the theme on hover, on press and on every `flushUpdate`, so a plain
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

  /** Every fact the bar draws, in one string. Cheap to compare. */
  private stateKey(): string {
    const ui = this.ui;
    return [
      ui.projectTitle,
      ui.model,
      ui.agentMode,
      ui.errors,
      ui.warnings,
      ui.unread,
      ui.needsApproval,
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
   * Refetch the remembered projects, once per project the header is opened in. `workspace.open`
   * is what changes the list, and it also changes which root is open — so the root is the cheap
   * signal that the list is stale, and the guard is what keeps `rebuild` from fetching forever.
   */
  private refreshRecents(): void {
    // Keyed on the root, not the title. Two projects may be called the same thing, and keying on
    // the title would show the second project's list under the first project's name, forever.
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
   * project and on the revision the invalidate watch bumps — a template is a file, so the
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

  /**
   * Refetch whether the page builder is installed, which decides whether one entry reads Install
   * or Update. Same shape as {@link refreshLayouts}, and keyed on the root for the reason
   * {@link refreshRecents} gives: two projects may share a title.
   *
   * The flag is deliberately not in {@link stateKey}. This guard is what stops the fetch from
   * repeating; putting the answer in the key as well would make every rebuild re-ask.
   */
  private refreshPages(): void {
    const key = `${this.ui.projectRoot}|${this.layoutRevision}`;
    if (this.pagesFor === key) return;
    this.pagesFor = key;

    void exec('project.pagesStatus').then((outcome) => {
      const data = outcome.ok ? (outcome.data as { installed?: boolean }) : undefined;
      this.pagesInstalled = data?.installed ?? false;
      this.rebuild();
    });
  }

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.refreshRecents();
    this.refreshLayouts();
    this.refreshPages();
    const ui = this.ui;

    this.bar.clear();
    this.anchors = redrawing(HEADER, 'bar');
    const [opens, layouts] = viewActions();
    for (const menu of HEADER_MENUS) {
      const button = this.menuButton(menu);
      if (menu.menu !== 'view') {
        button.description = menu.tooltip;
        continue;
      }
      this.anchors.record(button, opens);
      this.anchors.record(button, layouts);
    }
    this.badge(`project ${ui.projectTitle || '—'}`, true);
    this.runControls();

    const undo = this.bar.button('⟲', () => void move('undo'));
    undo.description = ui.undoLabel ? `Undo ${ui.undoLabel}` : 'Nothing to undo';
    undo.disabled = !ui.canUndo;

    const redo = this.bar.button('⟳', () => void move('redo'));
    redo.description = ui.redoLabel ? `Redo ${ui.redoLabel}` : 'Nothing to redo';
    redo.disabled = !ui.canRedo;

    if (ui.errors || ui.warnings) {
      const problems = problemsAction(ui.errors, ui.warnings);
      this.anchors.act(
        this.bar.button(problems.label, () => {}),
        problems,
        () => openDiagnostics(),
      );
    }

    this.modelMenu();
    this.retryBadge();
    this.badge(
      isLive ? 'live' : 'preview',
      false,
      isLive
        ? 'A real run: this window can call models and write assets'
        : 'A browser preview: every run is a dry run, and no model is called',
    );
    const modeOffer = modeAction(ui.agentMode);
    this.anchors.act(
      this.bar.button(modeOffer.label, () => {}),
      modeOffer,
      (action) => void setMode(String(action.props['mode'] ?? '')),
    );

    // The rect is read inside the callback, not here. The bar is still being built at this point
    // and the button has not been laid out yet, so a rect taken now would be the zero one.
    const approvals = approvalsAction(ui.needsApproval);
    const waiting = this.anchors.act(
      this.bar.button(approvals.label, () => {}),
      approvals,
      () => openApprovals(rectOf(waiting)),
    );

    const notes = notificationsAction(ui.unread);
    const bell = this.anchors.act(
      this.bar.button(notes.label, () => {}),
      notes,
      () => openNotifications(rectOf(bell)),
    );

    this.bar.flushUpdate();
  }

  /**
   * The run button, and — only while work the header stops is running — the spinner and the stop
   * button. All three read `ui.busy*`, which main pushes on both edges of the work and on every
   * task between, so none of them keeps a flag of its own that a crashed run could leave set.
   *
   * Which work gets a spinner and what its Stop runs is `busyControls`. An authoring turn is not in
   * that table, because the conversation editor owns its Stop button.
   */
  private runControls(): void {
    const busy = this.ui.busyWhat;

    const runOffer = runAction(busy, isLive);
    this.anchors.act(
      this.bar.button(runOffer.label, () => {}),
      runOffer,
      (action) => runPipelineNow(action.props),
    );

    this.spinner = undefined;
    const controls = busyControls(busy);
    this.controls = controls;
    if (!controls) return;

    const spinner = this.bar.label('◴');
    this.spinner = spinner;
    this.sayProgress();
    // Turned by the Web Animations API rather than a `@keyframes` rule: keyframe names resolve in
    // the element's own tree scope, and this label sits several shadow roots below the one
    // `adoptStyle` reaches. The box uses `setCSSAfter` because the theme rewrites it each pass.
    spinner.setCSSAfter(() => {
      spinner.style['padding'] = '0px 8px';
      spinner.style['display'] = 'inline-block';
    });
    spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration  : 1600,
      iterations: Infinity,
    });

    const stopOffer = stopAction(controls);
    const stop = this.anchors.act(
      this.bar.button(stopOffer.label, () => {}),
      stopOffer,
      (action) => void exec(action.id, action.props).then(report),
    );
    stop.setCSSAfter(() => (stop.style['color'] = 'var(--vermilion, #e5534b)'));
  }

  /**
   * The model the agent answers with, as a menu rather than a badge. The conversation editor
   * offers the same list; both go through `setModel`, so either one switches the other.
   */
  private modelMenu(): void {
    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined.
    const rows: MenuTemplate = TEXT_MODELS.map((id) => [
      id,
      () => void setModel(id),
      undefined,
      undefined,
      `Answer with ${id} from the next turn on.`,
      id,
    ]) as MenuTemplate;
    const model = modelAction(this.ui.model);
    this.anchors.record(this.bar.menu(model.label, rows), model);
  }

  /**
   * The retry counter, beside the model it is retrying. Drawn only while a retry is in flight.
   * It is a badge rather than a control: the author already answered the card that started the
   * retry, and the Stop button the turn already has is the way to end it early.
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
   * finishing would rebuild the whole bar, restarting the rotation from zero every few seconds.
   */
  private sayProgress(): void {
    if (!this.spinner || !this.controls) return;
    this.spinner.description = this.controls.progress(this.ui.busyRan, this.ui.busyPending);
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
   * Hands the active Gen Graph pane to a group entry, or says which pane the entries act on. The
   * active pane is `paneToUse`'s: the one the pointer last entered, else the biggest.
   */
  private withGenGraph(act: (pane: GroupActions) => void): void {
    const screen = (this.ctx as VnContext).state.screen;
    const panes = screen ? panesOf(screen) : [];
    const index = paneToUse(panes);
    const area = index === NO_PANE ? undefined : (screen!.sareas as ScreenArea[])[index]?.area;
    if (panes[index]?.editor !== 'gengraph' || area === undefined) {
      say('The group entries act on a Gen Graph pane. Point at one first.', true);
      return;
    }
    act(area as unknown as GroupActions);
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

  /** The split gesture, which needs the live mesh. */
  private splitArea(): void {
    this.ctx.screen.splitTool();
  }

  /**
   * One bar menu, built when it is pressed rather than when the bar is: the rows read the mesh and
   * the project as they are at that moment, and every command row is checked before it is drawn,
   * the way a right-click menu is. `_build_menu` is what the dropbox awaits on a press.
   */
  private menuButton(menu: HeaderMenu): ReturnType<Container['menu']> {
    const box = this.bar.menu(menu.title, []);
    box._build_menu = async () => {
      box._menu?.remove();
      box._menu = await buildMenu(
        this.ctx as VnContext,
        menu.title,
        menu.entries(this.menuState()),
        this.handlers,
      );
    };
    return box;
  }

  /** What the menus read, as of the press that opens one. */
  private menuState(): HeaderMenuState {
    const ui = this.ui;
    const screen = (this.ctx as VnContext).state.screen;
    const panes = screen ? panesOf(screen) : [];
    const active = paneToUse(panes);
    return {
      busyWhat      : ui.busyWhat,
      live          : isLive,
      agentMode     : ui.agentMode,
      recents       : this.recents,
      current       : this.current,
      layouts       : this.layouts,
      activeSlug    : this.activeSlug,
      layout        : this.serializedLayout(),
      pagesInstalled: this.pagesInstalled,
      activeEditor  : active === NO_PANE ? '' : (panes[active]?.editor ?? ''),
    };
  }

  /**
   * The arrangement on screen as a layout file, for Save Current Layout As…, or `''` where the
   * mesh cannot be serialized. Composed here because only this half can serialize one; main still
   * owns where the file goes and what it is called. The editor list is read off the mesh here
   * rather than in `layouts.ts`, which would have to import `view.ts` to do it, and `view.ts`
   * imports `layouts.ts`.
   */
  private serializedLayout(): string {
    const shell = (this.ctx as VnContext).state;
    const editors = shell.screen
      ? panesOf(shell.screen)
          .filter((pane) => !pane.chrome)
          .map((pane) => pane.editor)
          .filter((id): id is EditorId => (EDITOR_IDS as readonly string[]).includes(id))
      : [];
    const file = currentLayoutFile(shell, editors);
    return file ? serializeLayoutFile(file) : '';
  }
}

registerEditor(VnHeaderEditor, 'vn.VnHeaderEditor');
