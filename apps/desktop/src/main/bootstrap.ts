/**
 * The `app.whenReady()` sequence and the quit/window-all-closed lifecycle. Kept as one
 * sequential function (`runReady`) rather than split further: the comments inline document real
 * ordering constraints between the steps.
 */
import { app, Menu, nativeTheme } from 'electron';
import type { AppContext } from './context.js';
import { cliArgs } from './cliargs.js';
import { checkGit, gitHealth, noteGitHealth } from './doctor.js';
import { describeVersion, shortSha } from './version.js';
import { activatePlugins, pointAtUnpackedBinary } from './plugins.js';
import { formatSmoke, runSmoke } from './smoke.js';
import { acquireWorkspace, focusOwner } from './instancelock.js';
import { inspectWorkspace, rememberWorkspace } from './workspace.js';
import { askAboutGit, openRepos, resolveWorkspace } from './workspacelifecycle.js';
import { registerAssetProtocol } from './assetprotocol.js';
import { registerIpc } from './ipc.js';
import { openSessionStore } from './sessionaccess.js';
import {
  createWindow,
  focusFrontWindow,
  getWindowList,
  liveWindows,
  nameWindows,
  rememberedWindows,
} from './windowmanager.js';

/** Quitting is synchronous, so this holds it open for the two writes that may still be owed. */
const QUIT_FLUSH_MS = 2000;

async function runReady(ctx: AppContext): Promise<void> {
  // Before the menu, the session store, and any window: `--smoke` is a self-check a packaged
  // build runs about its own module resolution, and anything it opened would be a side effect
  // whose failure is not the one being reported.
  if (cliArgs.smoke) {
    // The same preparation a plugin build does, so the check exercises the path the app takes
    // rather than a bare import that would find the binary missing for a different reason.
    pointAtUnpackedBinary();
    const report = await runSmoke((spec) => import(spec));
    process.stdout.write(formatSmoke(report) + '\n');
    app.exit(report.ok ? 0 : 1);
    return;
  }

  // The renderer has one palette and it is dark, so following the OS would put a light native
  // dialog in front of it. Covers Electron-owned surfaces only; scrollbars and form controls
  // inside the renderer follow `color-scheme` in renderer/styles/tokens.css.
  nativeTheme.themeSource = 'dark';

  // No stock menu: this shell has its own bar, and the File/Edit/View scaffolding named things
  // it does not have. Quit and DevTools are the two accelerators worth keeping - they come back
  // as `window.quit` on Ctrl+Q in the renderer's keymap and F12 / Ctrl+I in `createWindow`.
  Menu.setApplicationMenu(null);

  // Before anything opens a workspace, because a missing git is what opening one will fail on.
  // A development build also learns its commit here; a packaged app has no repository to ask.
  noteGitHealth(await checkGit());
  if (!app.isPackaged) {
    ctx.appVersion = describeVersion(app.getVersion(), {
      packaged: false,
      sha     : await shortSha(app.getAppPath()),
    });
  }
  if (!gitHealth().ok) await askAboutGit();
  // The session store first: it is global per install, and it is where the recents list the
  // workspace is resolved from lives.
  await openSessionStore(ctx);
  await resolveWorkspace(ctx);

  // The lock is taken after the workspace resolves, deliberately: the root is not known until
  // then, and `resolveWorkspace` can put up an interactive picker, so an author may pick a repo
  // that turns out to be taken. VS Code also hands off after its picker.
  ctx.instanceLock = await acquireWorkspace(ctx.workspace(), () => focusFrontWindow(ctx));
  if (!ctx.instanceLock) {
    // Exit before creating any window, so the author sees the existing instance come forward
    // rather than a window that flashes and disappears.
    await focusOwner(ctx.workspace());
    app.exit(0);
    return;
  }

  // Before the first window, which reads its arrangement out of this file synchronously in its
  // preload.
  await ctx.getSessionState().openProject(ctx.workspace());
  await openRepos(ctx);
  rememberWorkspace(ctx.getSessionState(), ctx.workspace());
  registerAssetProtocol(ctx);
  registerIpc(ctx);

  // Before the first window, because a graph opened in one resolves its node types out of the
  // registry these activations land in. A refusal is filed as a notification rather than thrown,
  // so one bad plugin does not stop the app from opening.
  await activatePlugins();

  // Restore the arrangement this workspace was left in - each window at its own index, so each
  // one comes back into its own layout, selection and template rather than a default screen.
  const remembered = rememberedWindows(ctx);
  if (remembered.length === 0) createWindow(ctx);
  else for (const entry of remembered) createWindow(ctx, { bounds: entry.bounds });

  // The title is read from the workspace rather than remembered: the launch paths that skip
  // `openWorkspace` (`--project`, the recents branch) never learned it, and every path meets here.
  nameWindows(ctx, (await inspectWorkspace(ctx.workspace())).title ?? '');
  app.on('activate', () => {
    if (ctx.windows.size === 0) createWindow(ctx);
  });
}

/** Wires the whole app lifecycle — `whenReady`, `window-all-closed`, and the quit flush. */
export function wireLifecycle(ctx: AppContext): void {
  void app.whenReady().then(() => runReady(ctx));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Quitting is synchronous, so hold it open for the two writes that may still be owed: the
  // debounced session state, and a run of edits whose commit is deferred. Bounded either way,
  // because losing a panel width or a commit subject is a smaller failure than a quit that never
  // lands. 2000 covers a commit, which costs about 230 ms and does not grow with the project: the
  // cost is git's own process startup rather than the size of the tree `-A` stages.
  let flushingOnQuit = false;
  app.on('before-quit', () => {
    // A quit closes every window in a cascade, and the `closed` handler rewrites the list from
    // what is left - so without this the arrangement would be rewritten down to nothing on the
    // way out. Snapshot the open set first, then stop writing for the rest of the process.
    if (ctx.boundsTimer !== undefined) clearTimeout(ctx.boundsTimer);
    if (ctx.sessionState && ctx.workspaceRoot) getWindowList(ctx).freeze(liveWindows(ctx));
  });
  app.on('before-quit', (event) => {
    if (flushingOnQuit) return;
    const state = ctx.sessionState;
    // Asked of the stack only where one exists, since `getStack()` would build one on the way out.
    const batch = ctx.stack?.flushCommits();
    if (!state && !batch) return;
    flushingOnQuit = true;
    event.preventDefault();
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_MS).unref?.());
    // Awaited together and raced as one, since racing them separately against the deadline would
    // let the quit land the moment the faster of the two settled.
    const owed = Promise.all([state?.close().catch(() => {}), batch?.catch(() => {})]);
    void Promise.race([owed, deadline]).finally(() => app.quit());
  });
}
