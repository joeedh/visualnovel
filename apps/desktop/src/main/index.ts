/**
 * Electron main process. Owns the window, the workspace session, and the IPC surface
 * declared in `../shared/ipc.ts`. Renderer → main calls are `ipcMain.handle` (request /
 * response); main → renderer pushes (agent events, plan-approval requests) go over
 * `webContents.send`.
 *
 * Runs for real by default: pass `--mock` to skip model calls (mock providers, no key
 * required). The workspace is `--project <dir>` when that flag is given. Without it, the app
 * opens a scratch repo seeded from the bundled sample (see `./workspace.ts`). `VN_MOCK=1` / `VN_PROJECT=<dir>` are equivalent
 * fallbacks for callers that pass env instead of argv (e.g. `scripts/dev.desktop.mjs`); a CLI
 * flag wins over its env-var counterpart when both are given.
 *
 * The bootstrap sequence and the mutable process-wide state it needs are split across sibling
 * modules — `./context.ts` (the shared state), `./cliargs.ts`, `./windowmanager.ts`,
 * `./assetprotocol.ts`, `./sessionaccess.ts`, `./stack.ts`, `./ipc.ts`, `./workspacelifecycle.ts`
 * and `./bootstrap.ts` — this file only wires them together in the order Electron requires.
 */
import { app, protocol } from 'electron';
import { AppContext } from './runtime/context.js';
import { installAppNotifications } from './runtime/workspacelifecycle.js';
import { wireLifecycle } from './bootstrap/bootstrap.js';

/**
 * Opt-in, off by default: the remote-debugging port grants full control of the renderer, so
 * it is never opened implicitly. Bound to loopback. Must be set before `app.whenReady()`.
 */
const CDP_PORT = process.env.VN_CDP_PORT;
if (CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

// Must be declared before `app.ready`: teaches Electron that `vnasset://` and `vngit://` are
// real, image-loadable schemes (standard + secure) so `<img src="vnasset://…">` is allowed.
// `vngit://` serves a file as it was at a commit, for the History pane's picture diffs.
protocol.registerSchemesAsPrivileged([
  {
    scheme    : 'vnasset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme    : 'vngit',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const ctx = new AppContext(app.getVersion());
installAppNotifications(ctx);
wireLifecycle(ctx);
