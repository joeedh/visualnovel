/**
 * `view.*`, applied to the mesh. The command ran in main and said what it meant — show this
 * editor, focus it, close this pane, start over — and this is the half that moves panes.
 *
 * It returns the sentence the shell should say **instead** of the command's own when the mesh
 * disagrees with it: a focus with nothing to focus is the case that matters, and main cannot
 * know. Returning it rather than saying it here is what keeps this file out of the bridge's
 * import cycle.
 */
import { AreaFlags, type ScreenArea } from 'pathux';
import { editorTitle } from '../../src/shared/editors.js';
import type { EditorId, UiEffect } from '../../src/shared/ipc.js';
import type { ShellApp } from './context.js';
import { editorClass } from './editor.js';
import { NO_PANE, paneShowing, paneToClose, paneToUse, type Pane } from './panes.js';
import type { VnScreen } from './screen.js';

type ViewEffect = Extract<UiEffect, { type: 'view' }>;

export function applyView(app: ShellApp, effect: ViewEffect): string | null {
  const screen = app.screen;
  if (!screen) return null;

  switch (effect.action) {
    case 'open':
      return open(screen, effect.editor, effect.where);
    case 'focus':
      return focus(screen, effect.editor);
    case 'close':
      return close(screen);
    case 'reset':
      app.rebuild();
      return null;
  }
}

function open(
  screen: VnScreen,
  editor: EditorId,
  where: 'here' | 'right' | 'below',
): string | null {
  const cls = editorClass(editor);
  if (!cls) return `This build has no ${editorTitle(editor)} editor.`;

  const areas = screen.sareas as ScreenArea[];
  // Already open and asked for *here* is a focus: an author who says "show me the script" while
  // looking at it means "put me back in it", not "show it twice".
  if (where === 'here') {
    const showing = paneShowing(panesOf(screen), editor);
    if (showing !== NO_PANE) return focus(screen, editor);
  }

  const index = paneToUse(panesOf(screen));
  if (index === NO_PANE) return 'There is no pane to show it in.';
  const target = areas[index] as ScreenArea;

  // `horiz` splits top/bottom; the new half is the one that gets the editor, so the pane the
  // author was in keeps what it held.
  const sarea = where === 'here' ? target : screen.splitArea(target, 0.5, where === 'below');
  sarea.switch_editor(cls as unknown as Parameters<ScreenArea['switch_editor']>[0]);
  activate(screen, sarea);
  settle(screen);
  return null;
}

function focus(screen: VnScreen, editor: EditorId): string | null {
  const index = paneShowing(panesOf(screen), editor);
  if (index === NO_PANE) return `No pane is showing ${editorTitle(editor)}.`;
  activate(screen, (screen.sareas as ScreenArea[])[index] as ScreenArea);
  return null;
}

function close(screen: VnScreen): string | null {
  const index = paneToClose(panesOf(screen));
  if (index === NO_PANE) return 'This is the only pane — closing it would leave nothing.';
  screen.collapseArea((screen.sareas as ScreenArea[])[index] as ScreenArea);
  settle(screen);
  return null;
}

/** The mesh as the pure rules see it. */
function panesOf(screen: VnScreen): Pane[] {
  return (screen.sareas as ScreenArea[]).map((sarea) => ({
    editor: areaNameOf(sarea),
    chrome: Boolean(sarea.area && sarea.area.flag & AreaFlags.HIDDEN),
    active: screen.sareas.active === sarea,
    width: sarea.size[0] ?? 0,
    height: sarea.size[1] ?? 0,
  }));
}

function areaNameOf(sarea: ScreenArea): string {
  const cls = sarea.area?.constructor as { define?: () => { areaname?: string } } | undefined;
  return cls?.define?.().areaname ?? '';
}

/**
 * Make a pane the active one. The pointer decides this the rest of the time, so a command that
 * moved the author somewhere has to say so itself — otherwise the next command lands in
 * whatever pane the mouse happens to rest over.
 */
function activate(screen: VnScreen, sarea: ScreenArea): void {
  screen.sareas.active = sarea;
  if (sarea.area) {
    sarea.area.push_ctx_active();
    sarea.area.pop_ctx_active();
  }
}

/** Re-solve the mesh after it changed shape, and repaint what moved. */
function settle(screen: VnScreen): void {
  screen.solveAreaConstraints();
  screen.completeSetCSS();
  screen.completeUpdate();
}
