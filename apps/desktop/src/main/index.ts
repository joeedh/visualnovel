/**
 * Electron main process. Owns the window, the workspace session, and the IPC surface
 * declared in `../shared/ipc.ts`. Renderer → main calls are `ipcMain.handle` (request /
 * response); main → renderer pushes (agent events, plan-approval requests) go over
 * `webContents.send`.
 *
 * Runs for real by default: pass `--mock` to skip model calls (mock providers, no key
 * required). The workspace is `--project <dir>` if given, else a scratch repo seeded from the
 * bundled sample (see `./workspace.ts`). `VN_MOCK=1` / `VN_PROJECT=<dir>` are equivalent
 * fallbacks for callers that pass env instead of argv (e.g. `scripts/dev.desktop.mjs`); a CLI
 * flag wins over its env-var counterpart when both are given.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProjectPaths } from '@vn/store';
import { openGit, type Git } from '@vn/git';
import { appendJsonl } from '@vn/util';
import { Workspace } from '@vn/authoring';
import { CommandStack, Committer, UndoJournal } from '@vn/commands';
import { createDesktopRegistry, type CommandHost } from './commands/index.js';
import { catalogOf } from './commands/catalog-entry.js';
import { WorkspaceSession, type SessionDeps } from './session.js';
import { SessionStore } from './sessionstore.js';
import {
  ensureRepo,
  openWorkspace,
  recentWorkspaces,
  rememberWorkspace,
  seedWorkspace,
} from './workspace.js';
import type {
  InvokeChannel,
  InvokeChannels,
  PlanDecision,
  AskRequest,
  ConfirmRequest,
  PlanRequest,
  SessionValue,
  UiEffect,
} from '../shared/ipc.js';

/** `--mock` / `--project <dir>` (also `--project=<dir>`), parsed from the app's own argv. */
interface CliArgs {
  mock: boolean;
  project?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let mock = false;
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--mock') mock = true;
    else if (arg === '--project') project = argv[++i];
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
  }
  return { mock, project };
}

// Electron's own argv carries an extra `appPath` ('.') entry when running unpackaged
// (`electron .`) that a packaged executable's argv does not.
const cliArgs = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const MOCK = cliArgs.mock || process.env.VN_MOCK === '1';

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
/**
 * A request main is blocked on until the renderer answers it. Plan approval, a clarifying
 * question and an always-confirm tool are the same shape, so they share one: an id, the promise
 * the agent turn is parked on, and the answer {@link abandon} gives when nobody is left to ask —
 * a window that closes or a workspace that is torn down mid-turn must *end* the turn, and a
 * promise that nothing will ever resolve hangs the agent for the life of the process.
 */
class Pending<T> {
  private readonly waiting = new Map<number, (value: T) => void>();
  private seq = 0;

  constructor(private readonly abandoned: T) {}

  ask(send: (id: number) => void): Promise<T> {
    return new Promise<T>((resolve) => {
      const id = ++this.seq;
      this.waiting.set(id, resolve);
      send(id);
    });
  }

  answer(id: number, value: T): void {
    const resolve = this.waiting.get(id);
    if (!resolve) return;
    this.waiting.delete(id);
    resolve(value);
  }

  abandon(): void {
    const waiters = [...this.waiting.values()];
    this.waiting.clear();
    for (const resolve of waiters) resolve(this.abandoned);
  }
}

const pendingPlans = new Pending<PlanDecision>({ approved: false });
/** An unanswered question is silence, not a guess; an unanswered confirmation is a refusal. */
const pendingAsks = new Pending<string>('');
const pendingConfirms = new Pending<boolean>(false);

/** Nobody is left to ask: end every parked turn rather than leaving one blocked forever. */
function abandonPending(): void {
  pendingPlans.abandon();
  pendingAsks.abandon();
  pendingConfirms.abandon();
}

let workspaceRoot: string | null = null;

/** The resolved workspace. Only callable after `resolveWorkspace()` has run. */
function workspace(): string {
  if (!workspaceRoot) throw new Error('the workspace is only available after app ready');
  return workspaceRoot;
}

/**
 * Seed and open `examples/mySampleRepo` beside the template, so a run never writes into the
 * source tree. A packaged build has no repo-relative `examples/`, so the scratch workspace goes
 * under `userData` — and a missing template then fails by name rather than as a bare ENOENT
 * somewhere downstream.
 */
async function seedSample(): Promise<string> {
  const examples = join(__dirname, '..', '..', '..', '..', 'examples');
  const target = existsSync(examples)
    ? join(examples, 'mySampleRepo')
    : join(app.getPath('userData'), 'mySampleRepo');
  const result = await seedWorkspace(join(examples, 'sample'), target);
  if (result.seeded) console.log(`[vnstudio] seeded a new workspace at ${result.root}`);
  return result.root;
}

/**
 * "The app requests the user to pick a directory for the project" — a native directory dialog,
 * shown on a first run only. A folder that cannot be opened is reported and asked again rather
 * than falling through to the sample, which would look like the pick was ignored.
 */
async function promptForWorkspace(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: 'Open or create a VN project',
    buttonLabel: 'Open project',
    properties: ['openDirectory', 'createDirectory'],
  });
  const picked = result.filePaths[0];
  if (result.canceled || !picked) return undefined;
  try {
    return (await openWorkspace(picked)).root;
  } catch (err) {
    dialog.showErrorBox('Cannot open that folder', String(err));
    return promptForWorkspace();
  }
}

/**
 * Resolve the workspace once, before anything can ask for it: `--project` (or `VN_PROJECT`),
 * then the most recent project that still exists, then the picker, then the seeded sample.
 *
 * The picker therefore appears on a genuine first run only — whatever is opened is remembered,
 * including the sample, so cancelling is answered once and not every launch. `VN_NO_PICKER=1`
 * skips straight to the sample for automation that wants the old behaviour.
 */
async function resolveWorkspace(): Promise<void> {
  const project = cliArgs.project ?? process.env.VN_PROJECT;
  if (project) {
    workspaceRoot = resolvePath(project);
    return;
  }
  const recent = recentWorkspaces(getSessionStore()).find((dir) => existsSync(dir));
  if (recent) {
    workspaceRoot = recent;
    return;
  }
  const picked = process.env.VN_NO_PICKER === '1' ? undefined : await promptForWorkspace();
  workspaceRoot = picked ?? (await seedSample());
}

/**
 * Open a different project without restarting. Everything workspace-shaped in this module is a
 * singleton, so all of it is dropped: the session (with its agent conversation), the command
 * stack and its undo journal, the repo map, and the undo revision. Undo never crosses a
 * workspace boundary, and nothing may cache the root across this call.
 */
async function switchWorkspace(root: string): Promise<{ root: string; title: string }> {
  const opened = await openWorkspace(root);
  // The agent being dropped may be parked on a question nobody is going to answer now.
  abandonPending();
  workspaceRoot = opened.root;
  session = null;
  stack = null;
  ownedRepos.length = 0;
  undoRevision = 0;
  await openRepos();
  rememberWorkspace(getSessionStore(), opened.root);
  // Pushed directly rather than through the command host: the stack that is running the command
  // asking for this switch is the one being discarded.
  win?.webContents.send('command:ui', {
    type: 'workspace',
    root: opened.root,
    title: opened.title,
  });
  return { root: opened.root, title: opened.title };
}

/**
 * The repos the app may write history in — the project's, plus the story bible's when `wiki/`
 * is its own. Resolved once, after the workspace exists.
 *
 * A repo appears here only when the directory *is* its root. A project opened inside a larger
 * repo (a checkout of this monorepo, say) resolves to that repo, and committing `-A` there
 * would sweep in files that have nothing to do with the project — so commit-on-save stays off
 * rather than guessing at a scope. Undo is unaffected: shadow refs write nobody's history.
 */
const ownedRepos: Git[] = [];

/**
 * Bring the workspace under version control, then record anything changed outside the app as
 * its own event — a CLI run, another editor. That is what establishes the invariant every
 * later commit relies on: the app opens on a clean worktree, and every act ends with one.
 */
async function openRepos(): Promise<void> {
  const root = workspace();
  await ensureRepo(root);
  const refs = await new Workspace(root).repos();
  for (const ref of refs) {
    if (ref.owned) ownedRepos.push(openGit(ref.root));
    else console.warn(`[vnstudio] ${ref.role} sits inside ${ref.root}; not committing there`);
  }
  const committed = await committer().checkpoint('Changes made outside the app');
  for (const c of committed) console.log(`[vnstudio] checkpoint ${c.sha.slice(0, 8)} in ${c.repo}`);
}

function committer(): Committer {
  return new Committer({ repos: () => ownedRepos });
}

const deps: SessionDeps = {
  emitEvent: (event) => win?.webContents.send('agent:event', event),
  requestPlan: (plan) =>
    pendingPlans.ask((id) => {
      const request: PlanRequest = { id, plan };
      win?.webContents.send('permission:plan', request);
    }),
  requestAnswer: (question) =>
    pendingAsks.ask((id) => {
      const request: AskRequest = { id, question };
      win?.webContents.send('permission:ask', request);
    }),
  requestConfirm: (tool, detail) =>
    pendingConfirms.ask((id) => {
      const request: ConfirmRequest = { id, tool, detail };
      win?.webContents.send('permission:confirm', request);
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
 * What an undo snapshot covers: the authored documents, and nothing the pipeline generated.
 * `build/` is content-addressed and `state/` is an append-only log — rolling either back would
 * throw away work a later run has to pay for again, and excluding them is also what keeps a
 * `pipeline.run` between two edits from reading as workspace drift.
 */
const UNDO_PATHS = ['.', ':(exclude)vngen/build', ':(exclude)vngen/state'];

/** Counts undo/redo moves, so a room knows when the files changed under it. */
let undoRevision = 0;

/**
 * The one execution path for every command, whatever the caller. History is appended to
 * `vngen/state/commands.jsonl` alongside the pipeline's `tasks.jsonl`.
 */
function getStack(): CommandStack<CommandHost> {
  if (!stack) {
    const root = workspace();
    const paths = new ProjectPaths(root);
    const git = openGit(root);
    const host: CommandHost = {
      session: getSession(),
      state: getSessionStore(),
      ui: (effect: UiEffect) => win?.webContents.send('command:ui', effect),
      openWorkspace: (next: string) => switchWorkspace(next),
      pickDirectory: async () => {
        if (!win) throw new Error('there is no window to show a directory chooser in');
        const result = await dialog.showOpenDialog(win, {
          title: 'Open or create a VN project',
          buttonLabel: 'Open project',
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      // Lazily through `getStack`, not the local `stack`: the host is built while the stack
      // is still being constructed, so capturing it here would capture `undefined`.
      check: (id, props) => getStack().check(id, props),
    };
    stack = new CommandStack<CommandHost>({
      registry,
      context: {
        root,
        git,
        host,
        log: (level, message) => win?.webContents.send('log', { level, message }),
        // TODO(desktop): route through the renderer once a confirm dialog exists; until
        // then a `confirm: true` command is reachable only from the UI's own affordances.
        confirm: () => Promise.resolve(true),
      },
      // Undo still works where commit-on-save refuses: a shadow ref writes nobody's history,
      // so a project nested in a larger repo falls back to snapshotting that repo as before.
      journal: new UndoJournal({
        git: ownedRepos.length > 0 ? ownedRepos : git,
        paths: UNDO_PATHS,
      }),
      committer: committer(),
      onRecord: async (record) => {
        if (record.stack) undoRevision++;
        await appendJsonl(paths.commandsLog, record);
        host.ui({ type: 'undo', state: getStack().undoState(), revision: undoRevision });
      },
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
  handle('workspace:doctree', () => getSession().docTree());
  handle('workspace:filetree', () => getSession().fileTree());
  handle('agent:run', (input) => getSession().runAgent(input));
  handle('agent:setMode', (mode) => getSession().setMode(mode));
  handle('agent:setModel', (modelId) => getSession().setModel(modelId));
  handle('agent:clear', () => getSession().clearAgent());
  handle('plan:decision', (payload) => pendingPlans.answer(payload.id, payload.decision));
  handle('ask:answer', (payload) => pendingAsks.answer(payload.id, payload.answer));
  handle('confirm:decision', (payload) => pendingConfirms.answer(payload.id, payload.allowed));
  handle('pipeline:status', () => getSession().status());
  handle('pipeline:run', (opts) => getSession().runPipeline(opts.mock));
  handle('gate:candidates', (characterId) => getSession().gateCandidates(characterId));
  handle('gate:approve', (payload) =>
    getSession().approveCharacter(payload.characterId, payload.hash),
  );
  handle('story:play', () => getSession().playable());
  handle('story:graph', () => getSession().storyGraph());
  handle('story:coverage', (sceneId) => getSession().sceneCoverage(sceneId));

  // `catalogOf`, not a second `toCatalog` call: the two drifted, and the channel served a
  // catalog with no interactions while `commands.json` listed five.
  handle('command:catalog', () => catalogOf(registry));
  handle('command:exec', (request) => {
    const source = request.source ?? 'ui';
    if (request.dsl !== undefined) return getStack().execDsl(request.dsl, source);
    if (request.id === undefined) {
      return Promise.resolve({ ok: false as const, error: 'command:exec needs an id or a dsl' });
    }
    return getStack().exec(request.id, request.props ?? {}, source);
  });
  handle('command:check', (request) => getStack().check(request.id, request.props ?? {}));
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
 * so the standard-scheme host lowercasing is harmless). A missing file simply fails the
 * request and the caller falls back to a placeholder.
 *
 * **Both roots**, in the order `AssetStore` reads them: base art — portraits, model sheets,
 * location plates — lives beside the inputs at `assets/objects/`, and only shot frames are
 * under `vngen/build/assets/`. A url says nothing about which root it came from, and the
 * backlink panel's images are entirely the base kind (`docs/asset-stores.md`).
 *
 * The root is resolved per request, not captured: after `switchWorkspace` a captured one would
 * serve the previous project's bytes at the new project's hashes.
 */
function registerAssetProtocol(): void {
  protocol.handle('vnasset', (request) => {
    const host = new URL(request.url).hostname;
    const dot = host.lastIndexOf('.');
    const hash = dot > 0 ? host.slice(0, dot) : host;
    const ext = dot > 0 ? host.slice(dot + 1) : 'png';
    const paths = new ProjectPaths(workspace());
    const base = paths.baseAssetFile(hash, ext);
    const file = existsSync(base) ? base : paths.assetFile(hash, ext);
    return net.fetch(pathToFileURL(file).toString());
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
    // Every request out there was addressed to a window that is gone. Deny and answer nothing,
    // so an agent turn parked on one ends instead of holding the process open.
    abandonPending();
  });

  // The stock menu is gone (see `app.whenReady`), and with it F12. The renderer cannot open its
  // own devtools, so the accelerator is caught here instead of being lost with the menu.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
  });

  // The wiki pane's `beforeunload` guard refuses to unload while a draft is unsaved. Electron
  // *cancels* such a close outright unless somebody answers this event — which is why the window
  // could not be closed at all — and `preventDefault` here means "unload anyway".
  win.webContents.on('will-prevent-unload', (event) => {
    const leave = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Cancel', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'A document has unsaved changes.',
      detail: 'Closing now discards them.',
    });
    if (leave === 1) event.preventDefault();
  });
}

void app.whenReady().then(async () => {
  // No stock menu: this shell has its own bar, and the File/Edit/View scaffolding named things
  // it does not have. Quit and DevTools are the two accelerators worth keeping — they come back
  // as `Ctrl+Q` in the renderer's keymap and F12 in `createWindow`.
  Menu.setApplicationMenu(null);
  // The session store first: it is global per install, and it is where the recents list the
  // workspace is resolved from lives.
  await openSessionStore();
  await resolveWorkspace();
  await openRepos();
  rememberWorkspace(getSessionStore(), workspace());
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

// Quitting is synchronous, so hold it open for the one flush that may still be debounced — but
// bounded: losing a remembered panel width is a smaller failure than a quit that never lands.
const QUIT_FLUSH_MS = 2000;
let flushingOnQuit = false;
app.on('before-quit', (event) => {
  if (flushingOnQuit || !sessionStore) return;
  flushingOnQuit = true;
  event.preventDefault();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_MS).unref?.());
  void Promise.race([sessionStore.close().catch(() => {}), deadline]).finally(() => app.quit());
});
