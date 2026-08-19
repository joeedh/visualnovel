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
import { flashRect } from './flash.js';
import { markApplied } from './layouts.js';
import {
  NO_PANE,
  paneElsewhere,
  paneShowing,
  paneToClose,
  paneToShowIn,
  paneToUse,
  type Pane,
} from './panes.js';
import { SUBJECT_OF } from './route.js';
import type { VnScreen } from './screen.js';

type ViewEffect = Extract<UiEffect, { type: 'view' }>;

export function applyView(app: ShellApp, effect: ViewEffect): string | null {
  const screen = app.screen;
  if (!screen) return null;

  switch (effect.action) {
    case 'open':
      return flashed(
        screen,
        effect,
        withSubject(app, effect.editor, effect.subject, open(screen, effect.editor, effect.where)),
      );
    case 'focus':
      return flashed(
        screen,
        effect,
        withSubject(app, effect.editor, effect.subject, focus(screen, effect.editor)),
      );
    case 'close':
      return close(screen);
    case 'reset':
      app.rebuild();
      return null;
    case 'apply':
      if (!app.applyLayout(effect.layout)) {
        return `The ${effect.layout.title} layout could not be built in this window.`;
      }
      markApplied(effect.slug, effect.fingerprint);
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
  editor: EditorId,
  subject: string | undefined,
  correction: string | null,
): string | null {
  const field = SUBJECT_OF[editor];
  if (subject && field && !correction) app.ui[field] = subject;
  return correction;
}

/**
 * Outline the pane the effect landed in, when it asked to be noticed. After the mesh has settled,
 * so the rectangle measured is the one the author will see; skipped when the mesh disagreed with
 * the effect, since there is then no pane the correction is about.
 */
function flashed(screen: VnScreen, effect: ViewEffect, correction: string | null): string | null {
  // Only the two effects that name an editor can outline the pane it landed in. The rest moved
  // the whole window, and there is no one rectangle for that.
  if (effect.action !== 'open' && effect.action !== 'focus') return correction;
  if (correction || !effect.flash) return correction;
  const index = paneShowing(panesOf(screen), effect.editor);
  if (index === NO_PANE) return correction;
  const sarea = (screen.sareas as ScreenArea[])[index] as unknown as HTMLElement;
  flashRect(sarea.getBoundingClientRect());
  return correction;
}

/**
 * How big a popup opens, in pixels, before the screen clamps it.
 *
 * Big enough to read a list of tasks in, small enough to leave the mesh behind it visible — a
 * popup that covers the window is a modal dialog wearing a titlebar.
 */
const POPUP_SIZE: [number, number] = [520, 420];

type Split = { horiz: boolean; intoNew: boolean };

/** Which way `splitArea` divides, and whether the *new* half is the one that gets the editor. */
const SPLIT: Record<Exclude<OpenWhere, 'here' | 'elsewhere' | 'window' | 'popup'>, Split> = {
  left: { horiz: false, intoNew: false },
  right: { horiz: false, intoNew: true },
  above: { horiz: true, intoNew: false },
  below: { horiz: true, intoNew: true },
};

function open(screen: VnScreen, editor: EditorId, where: OpenWhere): string | null {
  const cls = editorClass(editor);
  if (!cls) return `This build has no ${editorTitle(editor)} editor.`;

  const areas = screen.sareas as ScreenArea[];
  // Already open and asked for a pane rather than a split is a focus: an author who says "show me
  // the script" while looking at it means "put me back in it", not "show it twice".
  if (where === 'here' || where === 'elsewhere' || where === 'popup') {
    const showing = paneShowing(panesOf(screen), editor);
    if (showing !== NO_PANE) return focus(screen, editor);
  }

  // A popup is a window of its own rather than a place in the mesh, so it neither splits nor
  // covers anything: nothing the author arranged moves to make room for it.
  if (where === 'popup') {
    const sarea = screen.popupArea(cls as unknown as Parameters<VnScreen['popupArea']>[0], {
      title: editorTitle(editor),
      width: Math.min(POPUP_SIZE[0], screen.size[0] * 0.9),
      height: Math.min(POPUP_SIZE[1], screen.size[1] * 0.9),
    });
    activate(screen, sarea as unknown as ScreenArea);
    return null;
  }

  const panes = panesOf(screen);
  const from = paneToUse(panes);
  if (from === NO_PANE) return 'There is no pane to show it in.';

  // Which pane the author is in, and which pane may be covered, are two questions: a split is
  // asked of where they are, and a replacement steps around a conversation if it can.
  let index = where === 'here' ? paneToShowIn(panes) : from;
  let split: Split | undefined;
  if (where === 'elsewhere') {
    // Anywhere but the pane doing the asking — the documents tree opening an asset into itself
    // would replace the tree. A window with only one pane has nowhere else, so it splits.
    index = paneElsewhere(panes, from);
    if (index === NO_PANE) {
      index = from;
      split = SPLIT.right;
    }
  } else if (where !== 'here' && where !== 'window') {
    split = SPLIT[where];
  }
  const target = areas[index] as ScreenArea;

  // `splitArea` keeps the target as the first half and returns a *copy* of it as the second, so
  // whichever half does not get the new editor still holds what the author was looking at. Which
  // half that is, is the whole difference between `left` and `right`.
  let sarea = target;
  if (split) {
    const made = screen.splitArea(target, 0.5, split.horiz);
    sarea = split.intoNew ? made : target;
  }
  sarea.switch_editor(cls as unknown as Parameters<ScreenArea['switch_editor']>[0]);
  activate(screen, sarea);
  settle(screen);
  return null;
}

function focus(screen: VnScreen, editor: EditorId): string | null {
  const index = paneShowing(panesOf(screen), editor);
  if (index === NO_PANE) return `No pane is showing ${editorTitle(editor)}.`;
  const sarea = (screen.sareas as ScreenArea[])[index] as ScreenArea;
  activate(screen, sarea);
  // A tiled pane is always as visible as it is going to get; a popup may be behind another one,
  // and focusing something the author cannot see is not focusing it.
  if (sarea.floating) sarea.bringToFront();
  return null;
}

function close(screen: VnScreen): string | null {
  const index = paneToClose(panesOf(screen));
  if (index === NO_PANE) return 'This is the only pane — closing it would leave nothing.';
  collapsePane(screen, index);
  return null;
}

/**
 * Collapse one pane and re-solve. Exported for the interactive picker, which chose an index the
 * author pointed at rather than the one the rules would have picked — the collapse itself, and the
 * settling that has to follow it, are the same act either way.
 */
export function collapsePane(screen: VnScreen, index: number): void {
  screen.collapseArea((screen.sareas as ScreenArea[])[index] as ScreenArea);
  settle(screen);
}

/**
 * The mesh as the pure rules see it. Exported for a surface about to route a click of its own:
 * `routeFor` needs the panes, and only this knows how to read them off the screen.
 */
export function panesOf(screen: VnScreen): Pane[] {
  return (screen.sareas as ScreenArea[]).map((sarea) => ({
    editor: areaNameOf(sarea),
    chrome: Boolean(sarea.area && sarea.area.flag & AreaFlags.HIDDEN),
    floating: Boolean(sarea.floating),
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
