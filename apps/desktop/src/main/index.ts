/**
 * Electron main process. Owns the window, the workspace session, and the IPC surface
 * declared in `../shared/ipc.ts`. Renderer → main calls are `ipcMain.handle` (request /
 * response); main → renderer pushes (agent events, plan-approval requests) go over
 * `webContents.send`.
 *
 * Defaults are offline-safe: the workspace is the bundled sample and the session runs in
 * mock mode unless `VN_MOCK=0` is set (which then requires a real key). Override the
 * workspace with `VN_PROJECT=<dir>`.
 */
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProjectPaths } from '@vn/store';
import { openGit } from '@vn/git';
import { appendJsonl } from '@vn/util';
import { CommandStack, toCatalog } from '@vn/commands';
import { createDesktopRegistry, type CommandHost } from './commands/index.js';
import { WorkspaceSession, type SessionDeps } from './session.js';
import type {
  InvokeChannel,
  InvokeChannels,
  PlanDecision,
  PlanRequest,
  UiEffect,
} from '../shared/ipc.js';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const MOCK = process.env.VN_MOCK !== '0';

/**
 * Opt-in, off by default: the remote-debugging port grants full control of the renderer, so
 * it is never opened implicitly. Bound to loopback. Must be set before `app.whenReady()`.
 */
const CDP_PORT = process.env.VN_CDP_PORT;
if (CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

// Must be declared before `app.ready`: teaches Electron that `vnasset://` is a real,
// image-loadable scheme (standard + secure) so `<img src="vnasset://…">` is allowed.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vnasset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let win: BrowserWindow | null = null;
let session: WorkspaceSession | null = null;
let stack: CommandStack<CommandHost> | null = null;
const pendingPlans = new Map<number, (decision: PlanDecision) => void>();
let planSeq = 0;

/** The bundled sample project: repo-root/examples/sample, relative to dist/main. */
function defaultWorkspace(): string {
  return process.env.VN_PROJECT ?? join(__dirname, '..', '..', '..', '..', 'examples', 'sample');
}

const deps: SessionDeps = {
  emitEvent: (event) => win?.webContents.send('agent:event', event),
  requestPlan: (plan) =>
    new Promise<PlanDecision>((resolve) => {
      const id = ++planSeq;
      pendingPlans.set(id, resolve);
      const request: PlanRequest = { id, plan };
      win?.webContents.send('permission:plan', request);
    }),
};

function getSession(): WorkspaceSession {
  if (!session) session = new WorkspaceSession(defaultWorkspace(), MOCK, deps);
  return session;
}

const registry = createDesktopRegistry();

/**
 * The one execution path for every command, whatever the caller. History is appended to
 * `vngen/state/commands.jsonl` alongside the pipeline's `tasks.jsonl`.
 */
function getStack(): CommandStack<CommandHost> {
  if (!stack) {
    const root = defaultWorkspace();
    const paths = new ProjectPaths(root);
    const host: CommandHost = {
      session: getSession(),
      ui: (effect: UiEffect) => win?.webContents.send('command:ui', effect),
    };
    stack = new CommandStack<CommandHost>({
      registry,
      context: {
        root,
        git: openGit(root),
        host,
        log: (level, message) => win?.webContents.send('log', { level, message }),
        // TODO(desktop): route through the renderer once a confirm dialog exists; until
        // then a `confirm: true` command is reachable only from the UI's own affordances.
        confirm: () => Promise.resolve(true),
      },
      onRecord: (record) => appendJsonl(paths.commandsLog, record),
    });
  }
  return stack;
}

/** Register against the channel map, so a handler can't drift from its declared signature. */
function handle<C extends InvokeChannel>(
  channel: C,
  fn: (
    ...args: Parameters<InvokeChannels[C]>
  ) => ReturnType<InvokeChannels[C]> | Promise<ReturnType<InvokeChannels[C]>>,
): void {
  ipcMain.handle(channel, (_event, ...args) => fn(...(args as Parameters<InvokeChannels[C]>)));
}

function registerIpc(): void {
  handle('workspace:index', () => getSession().index());
  handle('agent:run', (input) => getSession().runAgent(input));
  handle('agent:setMode', (mode) => getSession().setMode(mode));
  handle('agent:setModel', (modelId) => getSession().setModel(modelId));
  handle('agent:clear', () => getSession().clearAgent());
  handle('plan:decision', (payload: { id: number; decision: PlanDecision }) => {
    const resolve = pendingPlans.get(payload.id);
    if (resolve) {
      pendingPlans.delete(payload.id);
      resolve(payload.decision);
    }
  });
  handle('pipeline:status', () => getSession().status());
  handle('pipeline:run', (opts) => getSession().runPipeline(opts.mock));
  handle('gate:candidates', (characterId) => getSession().gateCandidates(characterId));
  handle('gate:approve', (payload) =>
    getSession().approveCharacter(payload.characterId, payload.hash),
  );
  handle('story:play', () => getSession().playable());

  handle('command:catalog', () => toCatalog(registry, '@vn/desktop'));
  handle('command:exec', (request) => {
    const source = request.source ?? 'ui';
    if (request.dsl !== undefined) return getStack().execDsl(request.dsl, source);
    if (request.id === undefined) {
      return Promise.resolve({ ok: false as const, error: 'command:exec needs an id or a dsl' });
    }
    return getStack().exec(request.id, request.props ?? {}, source);
  });
  handle('command:history', (limit) => getStack().history(limit));
  handle('command:undo', () => getStack().undo());
  handle('command:redo', () => getStack().redo());
}

/**
 * Serve stored asset bytes to the renderer over `vnasset://<hash>.<ext>` — the app's only
 * image-loading path. The url host carries `<hash>.<ext>` (sha256 hashes are lowercase hex,
 * so the standard-scheme host lowercasing is harmless); it maps to the content-addressed
 * file under the workspace's `build/assets/`. A missing file simply fails the request and
 * the runner falls back to a placeholder.
 */
function registerAssetProtocol(): void {
  const paths = new ProjectPaths(defaultWorkspace());
  protocol.handle('vnasset', (request) => {
    const host = new URL(request.url).hostname;
    const dot = host.lastIndexOf('.');
    const hash = dot > 0 ? host.slice(0, dot) : host;
    const ext = dot > 0 ? host.slice(dot + 1) : 'png';
    return net.fetch(pathToFileURL(paths.assetFile(hash, ext)).toString());
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#0E1116',
    title: 'vnstudio',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

void app.whenReady().then(() => {
  registerAssetProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
