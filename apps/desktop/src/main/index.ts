/**
 * Electron main process. Owns the window, the workspace session, and the IPC surface
 * declared in `../shared/ipc.ts`. Renderer → main calls are `ipcMain.handle` (request /
 * response); main → renderer pushes (agent events, plan-approval requests) go over
 * `webContents.send`.
 *
 * Defaults are offline-safe: the workspace is a scratch repo seeded from the bundled sample
 * (see `./workspace.ts`) and the session runs in mock mode unless `VN_MOCK=0` is set (which
 * then requires a real key). Override the workspace with `VN_PROJECT=<dir>`.
 */
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProjectPaths } from '@vn/store';
import { openGit } from '@vn/git';
import { appendJsonl } from '@vn/util';
import { CommandStack, toCatalog } from '@vn/commands';
import { createDesktopRegistry, type CommandHost } from './commands/index.js';
import { WorkspaceSession, type SessionDeps } from './session.js';
import { SessionStore } from './sessionstore.js';
import { seedWorkspace } from './workspace.js';
import type {
  InvokeChannel,
  InvokeChannels,
  PlanDecision,
  PlanRequest,
  SessionValue,
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
let sessionStore: SessionStore | null = null;
const pendingPlans = new Map<number, (decision: PlanDecision) => void>();
let planSeq = 0;

let workspaceRoot: string | null = null;

/** The resolved workspace. Only callable after `resolveWorkspace()` has run. */
function workspace(): string {
  if (!workspaceRoot) throw new Error('the workspace is only available after app ready');
  return workspaceRoot;
}

/**
 * Resolve the workspace once, before anything can ask for it. `VN_PROJECT` wins; otherwise
 * the app seeds and opens `examples/mySampleRepo` beside the template, so a run never writes
 * into the source tree. A packaged build has no repo-relative `examples/`, so the scratch
 * workspace goes under `userData` — and a missing template then fails by name rather than as
 * a bare ENOENT somewhere downstream.
 */
async function resolveWorkspace(): Promise<void> {
  if (process.env.VN_PROJECT) {
    workspaceRoot = process.env.VN_PROJECT;
    return;
  }
  const examples = join(__dirname, '..', '..', '..', '..', 'examples');
  const target = existsSync(examples)
    ? join(examples, 'mySampleRepo')
    : join(app.getPath('userData'), 'mySampleRepo');
  const result = await seedWorkspace(join(examples, 'sample'), target);
  if (result.seeded) console.log(`[vnstudio] seeded a new workspace at ${result.root}`);
  workspaceRoot = result.root;
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
  if (!session) session = new WorkspaceSession(workspace(), MOCK, deps);
  return session;
}

/** Opened once during `app.whenReady()`, before any window can ask for its snapshot. */
function getSessionStore(): SessionStore {
  if (!sessionStore) throw new Error('the session store is only available after app ready');
  return sessionStore;
}

/**
 * Every write broadcasts, whoever made it — that is what lets `view.panelSize` move a panel
 * live. The echo back to the window that made the change re-applies the same value.
 */
async function openSessionStore(): Promise<void> {
  sessionStore = await SessionStore.open(undefined, (key, value: SessionValue) => {
    win?.webContents.send('session:changed', { key, value });
  });
}

const registry = createDesktopRegistry();

/**
 * The one execution path for every command, whatever the caller. History is appended to
 * `vngen/state/commands.jsonl` alongside the pipeline's `tasks.jsonl`.
 */
function getStack(): CommandStack<CommandHost> {
  if (!stack) {
    const root = workspace();
    const paths = new ProjectPaths(root);
    const host: CommandHost = {
      session: getSession(),
      state: getSessionStore(),
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
  handle('story:graph', () => getSession().storyGraph());

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

  handle('session:set', (payload) => getSessionStore().set(payload.key, payload.value));
  // Synchronous on purpose (so the preload can hand the renderer its state before first
  // paint) and therefore registered directly: `handle` above is `ipcMain.handle`-only.
  ipcMain.on('session:snapshot:sync', (event) => {
    event.returnValue = getSessionStore().snapshot();
  });
}

/**
 * Serve stored asset bytes to the renderer over `vnasset://<hash>.<ext>` — the app's only
 * image-loading path. The url host carries `<hash>.<ext>` (sha256 hashes are lowercase hex,
 * so the standard-scheme host lowercasing is harmless); it maps to the content-addressed
 * file under the workspace's `build/assets/`. A missing file simply fails the request and
 * the runner falls back to a placeholder.
 */
function registerAssetProtocol(): void {
  const paths = new ProjectPaths(workspace());
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

void app.whenReady().then(async () => {
  await resolveWorkspace();
  await openSessionStore();
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

// Quitting is synchronous, so hold it open for the one flush that may still be debounced.
let flushingOnQuit = false;
app.on('before-quit', (event) => {
  if (flushingOnQuit || !sessionStore) return;
  flushingOnQuit = true;
  event.preventDefault();
  void sessionStore.close().finally(() => app.quit());
});
