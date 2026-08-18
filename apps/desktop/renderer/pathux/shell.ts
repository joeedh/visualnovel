import {
  IconManager,
  ScreenArea,
  ToolStack,
  UIBase,
  nstructjs,
  setIconManager,
  setIconMap,
  simple,
  type ContextLike,
  type DataAPI,
} from 'pathux';
import { installAgent } from './agent.js';
import { defineShellApi } from './api.js';
import { exec, installBridge } from './bridge.js';
import { editorNameProblems } from '../../src/shared/editors.js';
import {
  DEFAULT_RECIPE,
  isPane,
  recipeProblem,
  type LayoutFile,
  type LayoutRecipe,
} from '../../src/shared/layouts.js';
import { ShellContext, type ShellApp } from './context.js';
import { editorClass, switchableAreaNames } from './editor.js';
import { registerCustomIcons } from './icons.js';
// Importing an editor is what registers it, and registration is what puts it in the area
// switcher — so every ported editor is listed here whether or not a default screen uses it.
import './editors/asset.js';
import './editors/branch.js';
import './editors/convo.js';
import './editors/documents.js';
import './editors/graph.js';
import './editors/inspector.js';
import './editors/project.js';
import './editors/script.js';
import './editors/tasks.js';
import './editors/timeline.js';
import './editors/wiki.js';
import { HEADER_HEIGHT, VnHeaderEditor } from './editors/header.js';
import { PlayEditor } from './editors/play.js';
import { installKeymap } from './keymap.js';
import { installLayoutWatch } from './layouts.js';
import { installReportPreview } from './report.js';
import {
  installPersistence,
  loadScreen,
  restoreLayout,
  restoreSelection,
  saveLayout,
  watchLayout,
} from './persist.js';
import { VnScreen } from './screen.js';
import { ShellState } from './state.js';
import { installTheme } from './theme.js';
import { TOKENS } from './tokens.js';

class Shell implements ShellApp {
  toolstack: ToolStack;
  api: DataAPI;
  ui: ShellState;
  ctx: ShellContext;
  screen: VnScreen | undefined;
  readonly screenClass = VnScreen;

  constructor() {
    this.toolstack = new ToolStack();
    this.api = defineShellApi();
    this.ui = new ShellState();
    this.ctx = new ShellContext(this);
    this.toolstack.setRestrictedToolContext(this.ctx as unknown as ContextLike);
  }

  start() {
    restoreSelection(this.ui);
    if (!restoreLayout(this)) this.buildDefaultScreen();

    const screen = this.screen as VnScreen;
    screen.ctx = this.ctx as unknown as ContextLike;
    this.ensureHeader(screen);
    // A restored screen carries the size it was saved at, which is rarely this window's;
    // `update` notices and rescales the mesh, so nothing here has to compute the new size.
    screen.completeSetCSS();
    screen.completeUpdate();

    installKeymap(this);
    installBridge(this);
    // After the bridge, and whether or not a convo pane is open: the agent streams into the
    // store from boot, so a pane opened later shows what was already said.
    installAgent();
    installPersistence(this);
    // After the bridge, which is where `exec` and the invalidate feed come from.
    installLayoutWatch();
    installReportPreview();
    this.showRequestedEditor();
  }

  /**
   * `window.new(editor= subject=)` asks for a window that opens showing something in particular.
   * Main cannot say so over IPC — this runs before the renderer has answered anything — so the
   * request rides the url, and the window acts on it once, here, after its remembered
   * arrangement is already up. It goes through `view.open` rather than switching an area by
   * hand so that a window opened this way is recorded, and lands, exactly like a `view.open`
   * anywhere else. `elsewhere` rather than `here`: the remembered arrangement is the point, and
   * replacing whichever pane happened to be active would throw part of it away.
   */
  private showRequestedEditor(): void {
    const params = new URLSearchParams(location.search);
    const editor = params.get('editor');
    if (!editor) return;
    void exec('view.open', {
      editor,
      where: 'elsewhere',
      subject: params.get('subject') ?? '',
    });
  }

  /**
   * `view.layout` — throw the arrangement away and build the default one. The old screen is
   * destroyed rather than merely dropped: it holds window listeners, and two live screens both
   * answering the pointer is the shape of a haunted layout.
   */
  rebuild(): void {
    this.discardScreen();
    this.buildDefaultScreen();
    this.settleScreen();
  }

  /**
   * Rearrange the window to a layout template, reporting whether it took. A template carries
   * either a recipe or a saved mesh, and the two are built differently — but a refusal has to
   * come before the old screen goes, or a template that will not build leaves a blank window.
   */
  applyLayout(file: LayoutFile): boolean {
    if (file.recipe !== undefined) {
      if (recipeProblem(file.recipe) !== undefined) return false;
      this.discardScreen();
      this.buildScreen(file.recipe);
      this.settleScreen();
      return true;
    }

    if (!file.screen || typeof file.screen !== 'object') return false;
    const old = this.screen;
    if (!loadScreen(this, file.screen)) return false;
    // `loadFile` unlistens and removes the old screen but never destroys it, so the destroy
    // that `discardScreen` does has to happen here instead — after the new one is up.
    old?.destroy();
    this.settleScreen();
    return true;
  }

  private discardScreen(): void {
    const old = this.screen;
    old?.unlisten();
    old?.destroy();
    old?.remove();
  }

  /** What every path onto a new screen finishes with: header, layout, persistence. */
  private settleScreen(): void {
    const screen = this.screen as VnScreen;
    screen.ctx = this.ctx as unknown as ContextLike;
    this.ensureHeader(screen);
    screen.completeSetCSS();
    screen.completeUpdate();

    watchLayout(this);
    saveLayout(this);
  }

  /**
   * Put the header back at the top of the mesh, whatever the layout was. A stored layout may
   * predate the header, or have been saved by a build that had none, so this runs on every
   * boot rather than only on the default screen — the same reason path.ux's own
   * `AppState.ensureMenuBar` does.
   */
  private ensureHeader(screen: VnScreen): void {
    if (screen.sareas.some((sarea) => sarea.area instanceof VnHeaderEditor)) return;

    screen.update();

    let top = 1e17;
    let bottom = -1e17;
    for (const sarea of screen.sareas) {
      top = Math.min(top, sarea.pos[1]);
      bottom = Math.max(bottom, sarea.pos[1] + sarea.size[1]);
    }

    // Squeeze what is there into the space below the bar, in proportion, so a remembered
    // split stays the split the author left.
    const scale = (bottom - top - HEADER_HEIGHT) / (bottom - top);
    for (const sarea of screen.sareas) {
      sarea.pos[1] = sarea.pos[1] * scale + HEADER_HEIGHT;
      sarea.size[1] *= scale;
    }

    const bar = UIBase.createElement<ScreenArea>('screenarea-x');
    screen.appendChild(bar);
    bar.pos[0] = bar.pos[1] = 0;
    bar.size[0] = screen.size[0];
    bar.size[1] = HEADER_HEIGHT;

    screen.regenScreenMesh();
    screen.snapScreenVerts();
    bar.switchEditor(VnHeaderEditor, { deleteExisting: true });
    screen.solveAreaConstraints();
  }

  /**
   * The layout a project opens with when nothing was remembered. It is the Writing template's
   * own recipe rather than a second copy of that arrangement, so the default and the template
   * the menu offers cannot drift apart.
   */
  private buildDefaultScreen(): void {
    this.buildScreen(DEFAULT_RECIPE);
  }

  /**
   * Build a mesh from a recipe: divide first, fill after. Both orders make the same picture,
   * but only this one is safe — `splitArea` copies the area it divides, and a copy made before
   * the screen has been laid out carries no size to divide, so the screen goes into the
   * document before the first cut.
   */
  private buildScreen(recipe: LayoutRecipe): void {
    const screen = (this.screen = UIBase.createElement<VnScreen>('vn-screen-x'));
    screen.ctx = this.ctx as unknown as ContextLike;

    const root = screen.newScreenArea();
    root.switchEditor(PlayEditor, { deleteExisting: true });
    screen.add(root);

    screen.solveAreaConstraints();
    screen.regenBorders();

    document.body.appendChild(screen);
    screen.update();
    screen.setCSS();
    screen.listen();

    const leaves: [ScreenArea, readonly string[]][] = [];
    const cut = (sarea: ScreenArea, node: LayoutRecipe): void => {
      if (isPane(node)) {
        leaves.push([sarea, node.pane]);
        return;
      }
      // `splitArea` keeps `sarea` as the first half and returns the second; `horiz` divides by
      // height, so a recipe's rows are its horizontal cuts.
      const made = screen.splitArea(sarea, node.at, node.split === 'rows');
      cut(sarea, node.first);
      cut(made, node.second);
    };
    cut(root, recipe);

    for (const [sarea, editors] of leaves) {
      editors.forEach((id, i) =>
        sarea.switchEditor(editorClass(id) ?? PlayEditor, { deleteExisting: i === 0 }),
      );
      // Switching is how an editor gets made, so a pane ends up showing whichever was made
      // last. A recipe's pane reads front-to-back, so the first one named comes back up.
      const [front] = editors;
      if (front && editors.length > 1) sarea.switchEditor(editorClass(front) ?? PlayEditor);
    }
  }
}

/**
 * path.ux's own icon sheet, at the sizes and tile geometry `simple.AppState` uses. Every
 * widget that takes an icon (an area header's help button, for one) reads through the icon
 * manager, so a shell without one throws on the first header it builds.
 */
function installIcons(): void {
  const sheet = simple.loadDefaultIconSheet();
  const sizes: [number, number][] = [16, 24, 32, 48].map((size) => [32, size]);
  setIconManager(
    new IconManager(
      sizes.map(() => sheet),
      sizes,
      16,
    ),
  );
  setIconMap(simple.Icons);
  registerCustomIcons();
}

/**
 * Check that main and the renderer name the same editors, in **both** directions. `view.open`'s
 * props are built from `shared/editors.ts` in the main process, which cannot see this registry,
 * so an editor it offers that nothing registered fails only when someone picks it — and the
 * reverse, an editor registered here and named in no list, is worse: `view.*` cannot reach it at
 * all, yet path.ux's own area switcher offers it from the pane menu.
 */
function checkEditorNames(): void {
  const { unregistered, unnamed } = editorNameProblems(switchableAreaNames());
  if (unregistered.length > 0) {
    console.warn(`view.* offers editors this build has not registered: ${unregistered.join(', ')}`);
  }
  if (unnamed.length > 0) {
    console.warn(
      `editors registered but missing from EDITORS, so view.* cannot reach them: ${unnamed.join(', ')}`,
    );
  }
}

/**
 * Boot the path.ux shell into the document: the header bar plus whatever the remembered
 * layout held, or the default arrangement. Each further port lands as another editor
 * registered against the same screen.
 */
export function startShell(): void {
  // Theme before icons and before any widget builds its CSS — `setCSS` reads the live
  // theme once per element, so an override applied later leaves the first frame light.
  installTheme();
  installIcons();
  document.body.style.margin = '0px';
  document.body.style.padding = '0px';
  document.body.style.overflow = 'hidden';
  document.body.style.background = TOKENS.ink;

  nstructjs.validateStructs();
  checkEditorNames();
  new Shell().start();
}
