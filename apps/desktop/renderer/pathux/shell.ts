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
import { installBridge } from './bridge.js';
import { editorNameProblems } from '../../src/shared/editors.js';
import { ShellContext, type ShellApp } from './context.js';
import { editorClass, switchableAreaNames } from './editor.js';
// Importing an editor is what registers it, and registration is what puts it in the area
// switcher — so every ported editor is listed here whether or not a default screen uses it.
import './editors/asset.js';
import './editors/branch.js';
import './editors/convo.js';
import './editors/documents.js';
import './editors/graph.js';
import './editors/inspector.js';
import './editors/script.js';
import './editors/tasks.js';
import './editors/timeline.js';
import './editors/wiki.js';
import { HEADER_HEIGHT, VnHeaderEditor } from './editors/header.js';
import { PlayEditor } from './editors/play.js';
import { installKeymap } from './keymap.js';
import {
  installPersistence,
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
  }

  /**
   * `view.layout` — throw the arrangement away and build the default one. The old screen is
   * destroyed rather than merely dropped: it holds window listeners, and two live screens both
   * answering the pointer is the shape of a haunted layout.
   */
  rebuild(): void {
    const old = this.screen;
    old?.unlisten();
    old?.destroy();
    old?.remove();

    this.buildDefaultScreen();
    const screen = this.screen as VnScreen;
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
   * The layout a project opens with when nothing was remembered: the story on the left, the
   * agent on the right. With the room nav retired this is also what `view.layout` restores, so
   * it has to be somewhere to work from rather than the emptiest thing that renders.
   */
  private buildDefaultScreen(): void {
    const screen = (this.screen = UIBase.createElement<VnScreen>('vn-screen-x'));
    screen.ctx = this.ctx as unknown as ContextLike;

    const sarea = screen.newScreenArea();
    sarea.switchEditor(editorClass('script') ?? PlayEditor, { deleteExisting: true });
    sarea.switchEditor(editorClass('branches') ?? PlayEditor, { deleteExisting: false });
    screen.add(sarea);

    screen.solveAreaConstraints();
    screen.regenBorders();

    document.body.appendChild(screen);
    screen.update();
    screen.setCSS();
    screen.listen();

    // After the screen is in the document: `splitArea` copies the area it divides, and a copy
    // made before the first layout carries no size to divide.
    const right = screen.splitArea(sarea, 0.6, false);
    right.switchEditor(editorClass('convo') ?? PlayEditor, { deleteExisting: true });

    screen.splitArea(sarea, 0.3, false);
    sarea.switchEditor(editorClass('documents') ?? PlayEditor, { deleteExisting: true });
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
