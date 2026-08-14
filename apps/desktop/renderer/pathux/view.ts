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
import { editorTitle, type OpenWhere } from '../../src/shared/editors.js';
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
      return withSubject(app, effect.subject, open(screen, effect.editor, effect.where));
    case 'focus':
      return withSubject(app, effect.subject, focus(screen, effect.editor));
    case 'close':
      return close(screen);
    case 'reset':
      app.rebuild();
      return null;
  }
}

/**
 * Publish the subject, unless the mesh could not show the editor at all. A document set on a
 * pane that never opened would move every *other* document editor instead, which is the one way
 * this could be worse than doing nothing. The correction passes straight through.
 */
function withSubject(
  app: ShellApp,
  subject: string | undefined,
  correction: string | null,
): string | null {
  if (subject && !correction) app.ui.docPath = subject;
  return correction;
}

/** Which way `splitArea` divides, and whether the *new* half is the one that gets the editor. */
const SPLIT: Record<Exclude<OpenWhere, 'here'>, { horiz: boolean; intoNew: boolean }> = {
  left: { horiz: false, intoNew: false },
  right: { horiz: false, intoNew: true },
  above: { horiz: true, intoNew: false },
  below: { horiz: true, intoNew: true },
};

function open(screen: VnScreen, editor: EditorId, where: OpenWhere): string | null {
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

  // `splitArea` keeps the target as the first half and returns a *copy* of it as the second, so
  // whichever half does not get the new editor still holds what the author was looking at. Which
  // half that is, is the whole difference between `left` and `right`.
  let sarea = target;
  if (where !== 'here') {
    const split = SPLIT[where];
    const made = screen.splitArea(target, 0.5, split.horiz);
    sarea = split.intoNew ? made : target;
  }
  sarea.switch_editor(cls as unknown as Parameters<ScreenArea['switch_editor']>[0]);
  activate(screen, sarea);
  settle(screen);
  return null;
}

/**
 * Whether some pane is already showing an editor. Exported for a surface that is about to ask
 * for one: `view.open(where='here')` focuses an editor that is up and otherwise takes the asking
 * pane over, which for the sidebar means replacing itself with what it was trying to open.
 */
export function isShowing(screen: VnScreen, editor: EditorId): boolean {
  return paneShowing(panesOf(screen), editor) !== NO_PANE;
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
