import { AreaFlags, Menu, type Container, type MenuTemplate } from 'pathux';
import { isLive } from '../../api.js';
import { EDITORS } from '../../../src/shared/editors.js';
import { exec, move, quit, toggleMode } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openPalette } from '../palette.js';

/** The bar's fixed height. It is locked at both ends, so this is also its minimum. */
export const HEADER_HEIGHT = 34;

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
    this.rebuild();
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
      ui.canUndo,
      ui.canRedo,
      ui.undoLabel,
      ui.redoLabel,
    ].join('|');
  }

  private rebuild(): void {
    this.drawn = this.stateKey();
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
      // Not fired from the menu: `pipeline.run` asks before it writes, so the menu opens the
      // palette on its form. `mock` is seeded from whether this is a live app — a preview has
      // no keys and no main process, and a dry run is the only thing it could honestly do.
      ['Run Pipeline…', () => openPalette('pipeline.run', { mock: !isLive }), undefined],
      ['Open Project…', () => openPalette('workspace.pick'), undefined],
      ['Reindex Project', () => openPalette('workspace.reindex'), undefined],
      Menu.SEP,
      ['Plan ⇄ Execute', () => void toggleMode(), 'Shift+Tab'],
      ['Split Area', () => this.ctx.screen.splitTool(), undefined],
      Menu.SEP,
      ['Quit', () => quit(), 'Ctrl+Q'],
    ] as MenuTemplate;
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
