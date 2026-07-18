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
import { app, BrowserWindow, ipcMain, net, protocol, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProjectPaths } from '@vn/store';
import { WorkspaceSession, type SessionDeps } from './session.js';
import type { AgentMode, PlanDecision, PlanRequest } from '../shared/ipc.js';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const MOCK = process.env.VN_MOCK !== '0';

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

function registerIpc(): void {
  ipcMain.handle('workspace:index', () => getSession().index());
  ipcMain.handle('agent:run', (_event: IpcMainInvokeEvent, input: string) =>
    getSession().runAgent(input),
  );
  ipcMain.handle('agent:setMode', (_event: IpcMainInvokeEvent, mode: AgentMode) =>
    getSession().setMode(mode),
  );
  ipcMain.handle('agent:setModel', (_event: IpcMainInvokeEvent, modelId: string) =>
    getSession().setModel(modelId),
  );
  ipcMain.handle('agent:clear', () => getSession().clearAgent());
  ipcMain.handle(
    'plan:decision',
    (_event: IpcMainInvokeEvent, payload: { id: number; decision: PlanDecision }) => {
      const resolve = pendingPlans.get(payload.id);
      if (resolve) {
        pendingPlans.delete(payload.id);
        resolve(payload.decision);
      }
    },
  );
  ipcMain.handle('pipeline:status', () => getSession().status());
  ipcMain.handle('pipeline:run', (_event: IpcMainInvokeEvent, opts: { mock: boolean }) =>
    getSession().runPipeline(opts.mock),
  );
  ipcMain.handle('gate:candidates', (_event: IpcMainInvokeEvent, characterId: string) =>
    getSession().gateCandidates(characterId),
  );
  ipcMain.handle(
    'gate:approve',
    (_event: IpcMainInvokeEvent, payload: { characterId: string; hash: string }) =>
      getSession().approveCharacter(payload.characterId, payload.hash),
  );
  ipcMain.handle('story:play', () => getSession().playable());
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
