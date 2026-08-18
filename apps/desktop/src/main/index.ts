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
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  shell,
} from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProjectPaths } from '@vn/store';
import { openGit, type Git } from '@vn/git';
import { appendJsonl } from '@vn/util';
import { Workspace } from '@vn/authoring';
import { CommandStack, Committer, UndoJournal } from '@vn/commands';
import { DEFAULT_BUDGET, type BudgetChoice } from '@vn/types';
import { BUDGET_KEY } from './commands/agent.js';
import { createDesktopRegistry, type CommandHost } from './commands/index.js';
import { catalogOf } from './commands/catalog-entry.js';
import { ensureLayouts } from './layouts.js';
import { installNotifications, notifications, notify } from './notifications.js';
import { categoryOfCommand, shouldFileCommand } from '../shared/notify.js';
import { WorkspaceSession, type SessionDeps } from './session.js';
import { SessionStore } from './sessionstore.js';
import {
  acquireWorkspace,
  focusOwner,
  workspaceIsTaken,
  type InstanceLock,
} from './instancelock.js';
import {
  clampBounds,
  Pending,
  WindowList,
  Windows,
  type RememberedWindow,
  type WindowId,
} from './windows.js';
import { workspaceScope, windowsKey } from '../shared/sessionkeys.js';
import {
  adoptGitAttributes,
  ensureRepo,
  inspectWorkspace,
  openWorkspace,
  recentWorkspaces,
  rememberWorkspace,
  seedWorkspace,
} from './workspace.js';
import type {
  EventChannel,
  EventChannels,
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

/**
 * Every window onto this workspace. A window is a *view*: one process, one session, one command
 * stack, one project, N renderers. See `./windows.ts` for why the registry itself may not
 * import `electron`.
 */
const windows = new Windows<BrowserWindow>();
let session: WorkspaceSession | null = null;
let stack: CommandStack<CommandHost> | null = null;
let sessionStore: SessionStore | null = null;
/** The lock on the open project — one instance per workspace (`./instancelock.ts`). */
let instanceLock: InstanceLock | null = null;

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

/** One window closed. Only the turns parked on *that* window end; the others are still asked. */
function abandonPendingBy(id: WindowId): void {
  pendingPlans.by(id);
  pendingAsks.by(id);
  pendingConfirms.by(id);
}

/**
 * Where a push goes when nobody asked for it: the focused window, falling back to the most
 * recently focused one. Every *targeted* push resolves through here too, because a window that
 * closed between the command starting and the effect landing must not swallow the answer.
 */
function windowFor(target?: WindowId): BrowserWindow | undefined {
  const named = target === undefined ? undefined : windows.get(target);
  return named ?? windows.focusedHandle();
}

/** A fact about the process, not an answer to a question: every window hears it. */
function broadcast<C extends EventChannel>(channel: C, payload: EventChannels[C]): void {
  for (const { handle } of windows.all()) handle.webContents.send(channel, payload);
}

/** An answer to a question one window asked. */
function sendTo<C extends EventChannel>(
  target: WindowId | undefined,
  channel: C,
  payload: EventChannels[C],
): void {
  windowFor(target)?.webContents.send(channel, payload);
}

let workspaceRoot: string | null = null;

/** The resolved workspace. Only callable after `resolveWorkspace()` has run. */
function workspace(): string {
  if (!workspaceRoot) throw new Error('the workspace is only available after app ready');
  return workspaceRoot;
}

/**
 * Seed and open `examples/mySampleRepo`, so a run never writes into the template it was copied
 * from. The two live in different trees on purpose: `templates/basic` is committed, the whole of
 * `examples/` is gitignored, so a seeded workspace cannot dirty the checkout. **The presence of
 * the template is what says this is a source checkout** — `examples/` is ignored and a fresh
 * clone has none — and a packaged build, having neither, puts the scratch workspace under
 * `userData` and then fails by name rather than as a bare ENOENT somewhere downstream.
 */
async function seedSample(): Promise<string> {
  const repo = join(__dirname, '..', '..', '..', '..');
  const template = join(repo, 'templates', 'basic');
  const target = existsSync(template)
    ? join(repo, 'examples', 'mySampleRepo')
    : join(app.getPath('userData'), 'mySampleRepo');
  const result = await seedWorkspace(template, target);
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
/** The project's name, remembered so a window opened later can be titled like the rest. */
let projectTitle = '';

/**
 * Name every window after the project. The header shows it too, but the taskbar and the window
 * switcher see only this — and three windows all called `vnstudio` is not a list.
 *
 * With more than one window that problem comes straight back, so each title gains its own
 * ` (n)` while there is more than one, and loses it again when only one is left.
 */
function nameWindows(title: string = projectTitle): void {
  projectTitle = title;
  const base = title ? `${title} — vnstudio` : 'vnstudio';
  const open = windows.all();
  for (const { id, handle } of open) {
    handle.setTitle(open.length > 1 ? `${base} (${id + 1})` : base);
  }
}

async function switchWorkspace(root: string): Promise<{ root: string; title: string }> {
  // Acquire the new root *before* releasing the old one, so a switch never drops a lock it might
  // then fail to reclaim. `check` may have said yes a moment ago and been overtaken since, which
  // is why this re-decides rather than trusting it.
  const target = resolvePath(root);
  const lock =
    resolvePath(workspaceRoot ?? '') === target
      ? instanceLock
      : await acquireWorkspace(target, focusFrontWindow);
  if (!lock) {
    await focusOwner(target);
    throw new Error(`${target} is already open in another window.`);
  }

  const opened = await openWorkspace(root);
  if (instanceLock && instanceLock !== lock) await instanceLock.release();
  instanceLock = lock;
  // The agent being dropped may be parked on a question nobody is going to answer now.
  abandonPending();
  notifications().suspend();
  workspaceRoot = opened.root;
  session = null;
  stack = null;
  ownedRepos.length = 0;
  undoRevision = 0;
  await openRepos();
  rememberWorkspace(getSessionStore(), opened.root);
  // Pushed directly rather than through the command host: the stack that is running the command
  // asking for this switch is the one being discarded. Every window remounts — the workspace is
  // process-wide, so opening another project tears all of them down.
  broadcast('command:ui', { type: 'workspace', root: opened.root, title: opened.title });
  nameWindows(opened.title);
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
  // Here rather than in `openWorkspace`, because that runs only for an explicit `workspace.open`
  // — a project reached from the recents list or `VN_PROJECT` would never get the attribute. Not
  // when the project sits inside a larger repo: that history is somebody else's, as above.
  if (refs.some((ref) => ref.role === 'project' && ref.owned)) await adoptGitAttributes(root);
  const committed = await committer().checkpoint('Changes made outside the app');
  for (const c of committed) console.log(`[vnstudio] checkpoint ${c.sha.slice(0, 8)} in ${c.repo}`);
  // Only now: the checkpoint above is what a notification written earlier would have been
  // swept into, under a subject that has nothing to do with it.
  await notifications().open();
}

function committer(): Committer {
  return new Committer({ repos: () => ownedRepos });
}

/**
 * The notification hub. Installed at module load and dormant until `openRepos` opens it, so
 * nothing reaches `vngen/state` before the open-time checkpoint has swept the worktree.
 *
 * The log path is resolved per post rather than captured — `switchWorkspace` replaces the root
 * under it, and a captured one would write into a directory `workspace.create` is about to
 * require to be empty.
 */
installNotifications({
  file: () => (workspaceRoot ? new ProjectPaths(workspaceRoot).notificationsLog : undefined),
  // Broadcast, in full: the note frame is per-window chrome, so an author looking at the other
  // monitor should still see what happened, and every window's bell has a count to keep honest.
  push: (note) => broadcast('notify:changed', { note }),
});

/**
 * The window that started the current agent turn, remembered from `agent:run`'s sender. There is
 * one conversation, so there is one in-flight turn — a plan prompt therefore has exactly one
 * right place to land. A turn started by anything but a window (CDP, a schedule) leaves this
 * undefined and the prompt goes to the focused window, like any other unaddressed push.
 */
let turnWindow: WindowId | undefined;

/**
 * Ask the window that started the turn, and **focus it**: `agent:event` broadcasts, so every
 * window shows the agent thinking, and a prompt that landed unfocused on the other monitor would
 * read as a hung turn on the one the author is actually looking at. A window that went away
 * mid-turn falls back to the focused one rather than parking forever.
 */
function askWindow<T>(pending: Pending<T>, send: (id: number, win: BrowserWindow) => void) {
  const target = windowFor(turnWindow);
  if (!target) return Promise.resolve(pending.abandonedValue);
  const id = windows.byHandle(target);
  target.focus();
  return pending.ask((requestId) => send(requestId, target), id);
}

const deps: SessionDeps = {
  emitEvent: (event) => broadcast('agent:event', event),
  requestPlan: (plan) =>
    askWindow(pendingPlans, (id, target) => {
      const request: PlanRequest = { id, plan };
      target.webContents.send('permission:plan', request);
    }),
  requestAnswer: (question, choices) =>
    askWindow(pendingAsks, (id, target) => {
      const request: AskRequest = {
        id,
        question,
        ...(choices ? { choices: choices.options, multi: choices.multi } : {}),
      };
      target.webContents.send('permission:ask', request);
    }),
  requestConfirm: (tool, detail) =>
    askWindow(pendingConfirms, (id, target) => {
      const request: ConfirmRequest = { id, tool, detail };
      target.webContents.send('permission:confirm', request);
    }),
  appVersion: app.getVersion(),
  userData: app.getPath('userData'),
  openExternal: (url) => shell.openExternal(url),
  writeClipboard: (text) => clipboard.writeText(text),
  pushBusy: (state) => broadcast('command:ui', { type: 'busy', ...state }),
};

function getSession(): WorkspaceSession {
  if (!session) {
    session = new WorkspaceSession(workspace(), MOCK, deps);
    // The one agent setting that outlives the run: what a turn may spend is a decision about
    // this machine's bill, so it is restored here rather than re-chosen every launch.
    session.budget = getSessionStore().get<BudgetChoice>(BUDGET_KEY, DEFAULT_BUDGET);
  }
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
    broadcast('session:changed', { key, value });
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
      // Targeted: a `view.*` effect means *here*, in the window whose palette or menu ran the
      // command. `windowFor` falls back to the focused window for the agent, CDP and main.
      ui: (effect: UiEffect, target?: WindowId) => sendTo(target, 'command:ui', effect),
      openWorkspace: (next: string) => switchWorkspace(next),
      workspaceIsOpenElsewhere: async (next: string) => {
        const root = resolvePath(next);
        if (workspaceRoot && resolvePath(workspaceRoot) === root) return false;
        return workspaceIsTaken(root);
      },
      newWindow: async (options) => createWindow(options),
      closeWindow: (target?: WindowId) => {
        const target_ = windowFor(target);
        if (!target_) return false;
        target_.close();
        return true;
      },
      quitApp: () => app.quit(),
      windowCount: () => windows.size,
      focusedWindow: () => windows.focused() ?? 0,
      pickDirectory: async (options, target) => {
        const parent = windowFor(target);
        if (!parent) throw new Error('that window is gone');
        const result = await dialog.showOpenDialog(parent, {
          title: options?.title ?? 'Open or create a VN project',
          buttonLabel: options?.buttonLabel ?? 'Open project',
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      pickFiles: async (options, target) => {
        const parent = windowFor(target);
        if (!parent) throw new Error('that window is gone');
        const result = await dialog.showOpenDialog(parent, {
          title: options?.title ?? 'Upload documents',
          buttonLabel: options?.buttonLabel ?? 'Upload',
          properties: options?.single ? ['openFile'] : ['openFile', 'multiSelections'],
          ...(options?.extensions
            ? { filters: [{ name: options.filterName ?? 'Files', extensions: options.extensions }] }
            : {}),
        });
        return result.canceled ? [] : result.filePaths;
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
        log: (level, message) => broadcast('log', { level, message }),
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
        // The revision is what tells the renderer "files moved and you did not move them". An
        // undo/redo always qualifies; so does any mutating command that did not come from the
        // renderer's own `exec` — the agent, CDP, or main itself — because for those nothing on
        // that side invalidated, and the document tree would sit on a project that has changed.
        // A `ui` one is deliberately left out: `exec` already invalidated, and this would count
        // it twice.
        if (record.stack || (record.mutating && record.source !== 'ui')) undoRevision++;
        await appendJsonl(paths.commandsLog, record);
        // Every command, whoever ran it and however it ended — the palette, a menu, the agent,
        // CDP. One hook here is what makes "all notifications go through this system" true
        // without a call at each of the thirty places that used to `say()` their own outcome.
        // A refusal reaches this as a throw, so it arrives with `status: 'error'` and its reason.
        if (shouldFileCommand(record)) {
          await notify({
            category: record.status === 'ok' ? categoryOfCommand(record.id) : 'error',
            level: record.status === 'ok' ? 'info' : 'error',
            message: record.status === 'ok' ? record.message : (record.error ?? record.message),
            source: record.source === 'agent' || record.source === 'cdp' ? record.source : 'ui',
          });
        }
        // Broadcast: an undo is a worktree fact, not an answer. Ctrl+Z in window B undoes the
        // edit made in window A, deliberately — undo here is a shadow snapshot of the whole
        // worktree, so a per-window stack would be a lie about what it restores.
        broadcast('command:ui', {
          type: 'undo',
          state: getStack().undoState(),
          revision: undoRevision,
        });
      },
    });
  }
  return stack;
}

/**
 * Register against the channel map, so a handler can't drift from its declared signature.
 *
 * `origin` is which window asked — `undefined` for a sender that is not one of ours. Every
 * `view.*` effect used to be broadcast-by-accident: there was one listener, so "the window that
 * asked" and "the window there is" were the same window.
 */
function handle<C extends InvokeChannel>(
  channel: C,
  fn: (
    origin: WindowId | undefined,
    ...args: Parameters<InvokeChannels[C]>
  ) => ReturnType<InvokeChannels[C]> | Promise<ReturnType<InvokeChannels[C]>>,
): void {
  ipcMain.handle(channel, (event, ...args) =>
    fn(
      windows.byHandle(BrowserWindow.fromWebContents(event.sender)),
      ...(args as Parameters<InvokeChannels[C]>),
    ),
  );
}

function registerIpc(): void {
  handle('workspace:index', () => getSession().index());
  handle('workspace:doctree', () => getSession().docTree());
  handle('workspace:filetree', () => getSession().fileTree());
  handle('agent:run', (origin, input) => {
    // Remembered so a plan or a clarifying question lands where the turn was started.
    turnWindow = origin;
    return getSession().runAgent(input);
  });
  handle('agent:setMode', (_origin, mode) => getSession().setMode(mode));
  handle('agent:setModel', (_origin, modelId) => getSession().setModel(modelId));
  handle('agent:clear', () => getSession().clearAgent());
  handle('plan:decision', (_origin, payload) => pendingPlans.answer(payload.id, payload.decision));
  handle('ask:answer', (_origin, payload) => pendingAsks.answer(payload.id, payload.answer));
  handle('confirm:decision', (_origin, payload) =>
    pendingConfirms.answer(payload.id, payload.allowed),
  );
  handle('pipeline:status', () => getSession().status());
  handle('pipeline:run', (_origin, opts) => getSession().runPipeline(opts.mock));
  handle('gate:candidates', (_origin, characterId) => getSession().gateCandidates(characterId));
  handle('gate:approve', (_origin, payload) =>
    getSession().approveCharacter(payload.characterId, payload.hash),
  );
  handle('story:play', () => getSession().playable());
  handle('story:graph', () => getSession().storyGraph());
  handle('story:coverage', (_origin, sceneId) => getSession().sceneCoverage(sceneId));

  // `catalogOf`, not a second `toCatalog` call: the two drifted, and the channel served a
  // catalog with no interactions while `commands.json` listed five.
  handle('command:catalog', () => catalogOf(registry));
  handle('command:exec', (origin, request) => {
    const source = request.source ?? 'ui';
    if (request.dsl !== undefined) return getStack().execDsl(request.dsl, source, origin);
    if (request.id === undefined) {
      return Promise.resolve({ ok: false as const, error: 'command:exec needs an id or a dsl' });
    }
    return getStack().exec(request.id, request.props ?? {}, source, origin);
  });
  handle('command:check', (origin, request) =>
    getStack().check(request.id, request.props ?? {}, origin),
  );
  handle('command:history', (_origin, limit) => getStack().history(limit));
  handle('command:undo', () => getStack().undo());
  handle('command:redo', () => getStack().redo());

  handle('notify:list', () => notifications().list());
  handle('notify:post', (_origin, input) => notifications().post(input));

  handle('session:set', (_origin, payload) => getSessionStore().set(payload.key, payload.value));
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

/** The scope segment every one of this workspace's session keys hangs off. */
function scope(): string {
  return workspaceScope(workspace());
}

/**
 * The remembered arrangement, rewritten from the live set and frozen at `before-quit` — a quit
 * closes every window in a cascade, which would otherwise rewrite the list down to nothing.
 * Frozen per workspace rather than per process, since an instance only ever owns one.
 */
let windowList: WindowList | null = null;

function getWindowList(): WindowList {
  if (!windowList) {
    // The cast is the JSON boundary: `RememberedWindow` is plain data all the way down, but
    // `SessionValue` is an index-signature type and a named interface does not satisfy one.
    windowList = new WindowList((open) =>
      getSessionStore().set(windowsKey(scope()), open as unknown as SessionValue),
    );
  }
  return windowList;
}

/** Where each open window is, in the order the indices run. */
function liveWindows(): RememberedWindow[] {
  return windows.all().map(({ id, handle }) => ({ id, bounds: handle.getBounds() }));
}

/** Coalesced the same way the session store's own flush is: a drag is one write, not sixty. */
const BOUNDS_DEBOUNCE_MS = 400;
let boundsTimer: ReturnType<typeof setTimeout> | undefined;

function rememberWindows(): void {
  if (boundsTimer !== undefined) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = undefined;
    getWindowList().rewrite(liveWindows());
  }, BOUNDS_DEBOUNCE_MS);
  boundsTimer.unref?.();
}

/** Bring the front window forward — what a second instance's hand-off asks this one to do. */
function focusFrontWindow(): void {
  const front = windows.focusedHandle();
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
function rememberedWindows(): RememberedWindow[] {
  const stored = getSessionStore().snapshot()[windowsKey(scope())];
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

/** What a new window may be opened straight onto - `window.new(editor= subject=)`. */
interface NewWindowOptions {
  editor?: string;
  subject?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

function createWindow(options: NewWindowOptions = {}): WindowId {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    ...(options.bounds ?? {}),
    backgroundColor: '#0E1116',
    title: 'vnstudio',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const id = windows.add(win);

  // A window knows its own index - and its workspace - from its URL. The preload can read
  // `location.search` before first paint, which is why `session.initial()` is `sendSync` at all,
  // and for free the index lands in the CDP target list, which is what makes `--window` work.
  const query: Record<string, string> = { window: String(id), ws: scope() };
  if (options.editor) query.editor = options.editor;
  if (options.subject) query.subject = options.subject;
  if (DEV_URL) {
    const url = new URL(DEV_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), { query });
  }

  win.on('focus', () => windows.touch(id));
  win.on('moved', rememberWindows);
  win.on('resized', rememberWindows);
  win.on('closed', () => {
    windows.remove(id);
    // Only *this* window's requests. With one window "that window closed" and "there is nobody
    // left" were the same fact; with four, ending every parked turn would be a bug.
    abandonPendingBy(id);
    if (windows.size === 0) abandonPending();
    // Closing a window deliberately means it does not come back, so the list is rewritten from
    // what is left - unless a quit already froze it.
    getWindowList().rewrite(liveWindows());
    nameWindows();
  });

  // The stock menu is gone (see `app.whenReady`), and with it F12. The renderer cannot open its
  // own devtools, so the accelerator is caught here instead of being lost with the menu. On
  // *this* window: it is registered per window, and reaching for a module global was already
  // wrong before a second window could exist to prove it.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  // The wiki pane's `beforeunload` guard refuses to unload while a draft is unsaved. Electron
  // *cancels* such a close outright unless somebody answers this event - which is why the window
  // could not be closed at all - and `preventDefault` here means "unload anyway". Asked once per
  // window, including during the cascade a quit produces.
  win.webContents.on('will-prevent-unload', (event) => {
    const leave = dialog.showMessageBoxSync(win, {
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

  nameWindows();
  return id;
}

void app.whenReady().then(async () => {
  // No stock menu: this shell has its own bar, and the File/Edit/View scaffolding named things
  // it does not have. Quit and DevTools are the two accelerators worth keeping - they come back
  // as `window.quit` on Ctrl+Q in the renderer's keymap and F12 in `createWindow`.
  Menu.setApplicationMenu(null);
  // The session store first: it is global per install, and it is where the recents list the
  // workspace is resolved from lives.
  await openSessionStore();
  await resolveWorkspace();

  // The lock is taken *after* the workspace resolves, and that ordering is the whole point: the
  // root is not known until then, and `resolveWorkspace` can put up an interactive picker, so an
  // author may pick a repo that turns out to be taken. Handing off from after the picker is what
  // VS Code does too.
  instanceLock = await acquireWorkspace(workspace(), focusFrontWindow);
  if (!instanceLock) {
    // Exit **before creating any window**, so the author sees the existing instance come forward
    // rather than a window that flashes and disappears.
    await focusOwner(workspace());
    app.exit(0);
    return;
  }

  // Also in `openWorkspace`, but neither `--project` nor the recents branch goes through it -
  // and those are the normal launch paths, so without this the layout files never land.
  await ensureLayouts(workspace());
  await openRepos();
  rememberWorkspace(getSessionStore(), workspace());
  registerAssetProtocol();
  registerIpc();

  // Restore the arrangement this workspace was left in - each window at its own index, so each
  // one comes back into its own layout, selection and template rather than a default screen.
  const remembered = rememberedWindows();
  if (remembered.length === 0) createWindow();
  else for (const entry of remembered) createWindow({ bounds: entry.bounds });

  // Read rather than remembered: the launch paths that skip `openWorkspace` (`--project`, the
  // recents branch) never learned the title, and this is the one place all of them meet.
  nameWindows((await inspectWorkspace(workspace())).title ?? '');
  app.on('activate', () => {
    if (windows.size === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quitting is synchronous, so hold it open for the one flush that may still be debounced - but
// bounded: losing a remembered panel width is a smaller failure than a quit that never lands.
const QUIT_FLUSH_MS = 2000;
let flushingOnQuit = false;
app.on('before-quit', () => {
  // A quit closes every window in a cascade, and the `closed` handler rewrites the list from
  // what is left - so without this the arrangement would be rewritten down to nothing on the way
  // out. Snapshot the open set first, then stop writing for the rest of the process.
  if (boundsTimer !== undefined) clearTimeout(boundsTimer);
  if (sessionStore && workspaceRoot) getWindowList().freeze(liveWindows());
});
app.on('before-quit', (event) => {
  if (flushingOnQuit || !sessionStore) return;
  flushingOnQuit = true;
  event.preventDefault();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_MS).unref?.());
  void Promise.race([sessionStore.close().catch(() => {}), deadline]).finally(() => app.quit());
});
