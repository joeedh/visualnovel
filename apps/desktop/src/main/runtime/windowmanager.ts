/**
 * Window creation, the remembered on-disk arrangement, and window titling. Everything here reads
 * or writes `ctx.windows`/`ctx.windowList`; the mutable state itself lives on `AppContext`
 * (`./context.ts`) so this module and `./workspacelifecycle.ts` can each call into the other
 * without an import cycle.
 */
import { BrowserWindow, dialog, screen } from 'electron';
import { ZOOM_KEY } from '../../shared/zoom.js';
import { join } from 'node:path';
import type { AppContext } from './context.js';
import { clampBounds, WindowList, type RememberedWindow, type WindowId } from './windows.js';
import { WINDOWS_KEY } from '../../shared/sessionkeys.js';
import type { SessionValue } from '../../shared/ipc.js';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

/** What a new window may be opened straight onto - `window.new(editor= subject=)`. */
export interface NewWindowOptions {
  editor?: string;
  subject?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

/**
 * Name every window after the project. The header shows the title too, but the taskbar and the
 * window switcher show only the window title, and three windows all called `vnstudio` cannot be
 * told apart.
 *
 * Identical project titles have the same problem, so each title gains a ` (n)` suffix while
 * more than one window is open, and loses it again when only one is left.
 */
export function nameWindows(ctx: AppContext, title: string = ctx.projectTitle): void {
  ctx.projectTitle = title;
  const base = title ? `${title} — vnstudio` : 'vnstudio';
  const open = ctx.windows.all();
  for (const { id, handle } of open) {
    handle.setTitle(open.length > 1 ? `${base} (${id + 1})` : base);
  }
}

/**
 * The remembered arrangement, rewritten from the live set and frozen at `before-quit` — a quit
 * closes every window in a cascade, which would otherwise rewrite the list down to nothing.
 * Frozen per workspace rather than per process, since an instance only ever owns one.
 */
export function getWindowList(ctx: AppContext): WindowList {
  if (!ctx.windowList) {
    // The cast crosses the JSON boundary: `RememberedWindow` is plain data all the way down, but
    // `SessionValue` is an index-signature type, and a named interface does not satisfy one.
    ctx.windowList = new WindowList((open) =>
      ctx.getSessionState().set(WINDOWS_KEY, open as unknown as SessionValue),
    );
  }
  return ctx.windowList;
}

/** Where each open window is, in the order the indices run. */
export function liveWindows(ctx: AppContext): RememberedWindow[] {
  return ctx.windows.all().map(({ id, handle }) => ({ id, bounds: handle.getBounds() }));
}

/** Coalesced the same way the session store's own flush is: a drag is one write, not sixty. */
const BOUNDS_DEBOUNCE_MS = 400;

export function rememberWindows(ctx: AppContext): void {
  if (ctx.boundsTimer !== undefined) clearTimeout(ctx.boundsTimer);
  ctx.boundsTimer = setTimeout(() => {
    ctx.boundsTimer = undefined;
    getWindowList(ctx).rewrite(liveWindows(ctx));
  }, BOUNDS_DEBOUNCE_MS);
  ctx.boundsTimer.unref?.();
}

/** Bring the front window forward — what a second instance's hand-off asks this one to do. */
export function focusFrontWindow(ctx: AppContext): void {
  const front = ctx.windows.focusedHandle();
  if (!front) return;
  if (front.isMinimized()) front.restore();
  front.show();
  front.focus();
}

/**
 * The windows this workspace had open last time, clamped onto the displays that exist now. A
 * window whose monitor is gone would otherwise be restored invisible, which is indistinguishable
 * from one that never opened.
 */
export function rememberedWindows(ctx: AppContext): RememberedWindow[] {
  const stored = ctx.getSessionState().snapshot()[WINDOWS_KEY];
  if (!Array.isArray(stored)) return [];
  const displays = screen.getAllDisplays();
  const out: RememberedWindow[] = [];
  for (const entry of stored) {
    const row = entry as Partial<RememberedWindow>;
    if (typeof row?.id !== 'number' || !row.bounds) continue;
    const { x, y, width, height } = row.bounds;
    if ([x, y, width, height].some((n) => typeof n !== 'number')) continue;
    out.push({ id: row.id, bounds: clampBounds({ x, y, width, height }, displays) });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Point a window at the renderer, for the workspace open right now. A window knows its own index
 * and its workspace from its url: the preload can read `location.search` before first paint,
 * which is why `session.initial()` is `sendSync` at all, and for free the index lands in the CDP
 * target list, which is what makes `--window` work.
 *
 * Called again to reload a window after a workspace switch, which is why the url is built here
 * rather than inline in `createWindow`.
 */
export function loadWindow(
  ctx: AppContext,
  win: BrowserWindow,
  id: WindowId,
  options: NewWindowOptions = {},
): void {
  const query: Record<string, string> = { window: String(id), ws: ctx.scope() };
  if (options.editor) query.editor = options.editor;
  if (options.subject) query.subject = options.subject;
  if (DEV_URL) {
    const url = new URL(DEV_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), { query });
  }
}

/**
 * Zoom every open window to `factor` and remember it, so the next window opens at the same size.
 * Electron persists a zoom level per origin on its own, but only for the session's life; the
 * store is what carries it across a restart.
 */
export function applyZoom(ctx: AppContext, factor: number): void {
  ctx.getSessionState().set(ZOOM_KEY, factor);
  for (const { handle } of ctx.windows.all()) handle.webContents.setZoomFactor(factor);
}

export function createWindow(ctx: AppContext, options: NewWindowOptions = {}): WindowId {
  const zoom = ctx.getSessionState().get(ZOOM_KEY, 1);
  const win = new BrowserWindow({
    width    : 1360,
    height   : 860,
    minWidth : 880,
    minHeight: 620,
    ...(options.bounds ?? {}),
    backgroundColor: '#0E1116',
    title          : 'vnstudio',
    webPreferences: {
      preload         : join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration : false,
      zoomFactor      : zoom,
    },
  });
  const id = ctx.windows.add(win);

  loadWindow(ctx, win, id, options);
  // `zoomFactor` above is the page's default, which a reload resets; the remembered factor is
  // re-applied after every load so a refreshed window keeps its size
  win.webContents.on('did-finish-load', () => {
    const remembered = ctx.getSessionState().get(ZOOM_KEY, 1);
    if (win.webContents.getZoomFactor() !== remembered) win.webContents.setZoomFactor(remembered);
  });

  win.on('focus', () => ctx.windows.touch(id));
  win.on('moved', () => rememberWindows(ctx));
  win.on('resized', () => rememberWindows(ctx));
  win.on('closed', () => {
    ctx.windows.remove(id);
    // Ends only this window's requests. With four windows open, ending every parked turn because
    // one closed would be a bug.
    ctx.abandonPendingBy(id);
    if (ctx.windows.size === 0) ctx.abandonPending();
    // Closing a window deliberately means it does not come back, so the list is rewritten from
    // what is left - unless a quit already froze it.
    getWindowList(ctx).rewrite(liveWindows(ctx));
    nameWindows(ctx);
  });

  // Removing the stock menu (see `app.whenReady`) also removed F12, and the renderer cannot open
  // its own devtools, so the accelerators are caught here (F12 and Ctrl+I alone).
  // Registered per window on purpose: a
  // module global would target the wrong window once more than one exists.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrlI =
      input.control && !input.shift && !input.alt && !input.meta && input.key.toLowerCase() === 'i';
    if (input.key === 'F12' || ctrlI) win.webContents.toggleDevTools();
  });

  // The wiki pane's `beforeunload` guard refuses to unload while a draft is unsaved, and Electron
  // cancels the close outright unless this event is answered; `preventDefault` here means "unload
  // anyway". Asked once per window, including during the cascade a quit produces.
  win.webContents.on('will-prevent-unload', (event) => {
    const leave = dialog.showMessageBoxSync(win, {
      type     : 'warning',
      buttons  : ['Cancel', 'Discard and close'],
      defaultId: 0,
      cancelId : 0,
      title    : 'Unsaved changes',
      message  : 'A document has unsaved changes.',
      detail:
        'The pane holding it is outlined in the window. Cancel to go back and save it; closing ' +
        'now discards the changes.',
    });
    if (leave === 1) event.preventDefault();
  });

  nameWindows(ctx);
  return id;
}
