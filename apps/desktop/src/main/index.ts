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
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  screen,
  shell,
} from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { ProjectPaths } from '@vn/store';
import { openGit, type Git } from '@vn/git';
import { appendJsonl } from '@vn/util';
import { Workspace } from '@vn/authoring';
import { CommandStack, Committer, seqRanges } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import { DEFAULT_BUDGET, type BudgetChoice } from '@vn/types';
import { BUDGET_KEY } from './commands/agent.js';
import { createDesktopRegistry, type CommandHost } from './commands/index.js';
import { catalogOf } from './commands/catalog-entry.js';
import { fileCache, forgetFiles, snapshotStore } from './filecache.js';
import { liveDocs } from './livedocs.js';
import { installNotifications, notifications, notify } from './notifications.js';
import {
  checkGit,
  gitHealth,
  noteGitHealth,
  GIT_DOWNLOAD_URL,
  GIT_MISSING_MESSAGE,
} from './doctor.js';
import { describeVersion, shortSha } from './version.js';
import { activatePlugins, pointAtUnpackedBinary } from './plugins.js';
import { formatSmoke, runSmoke } from './smoke.js';
import { categoryOfCommand, shouldFileCommand } from '../shared/notify.js';
import { WorkspaceSession, type SessionDeps } from './session.js';
import { SessionStore } from './sessionstore.js';
import { SessionState } from './sessionstate.js';
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
import { workspaceScope, APPROVAL_ORDER_KEY, WINDOWS_KEY } from '../shared/sessionkeys.js';
import { sameApprovals } from './approvals.js';
import {
  commitScaffolding,
  ensureRepo,
  inspectWorkspace,
  openWorkspace,
  recentWorkspaces,
  rememberWorkspace,
  seedWorkspace,
  UNDO_EXCLUDES,
  writeScaffolding,
} from './workspace.js';
import type {
  DocVersions,
  EventChannel,
  EventChannels,
  ExecOutcome,
  InvokeChannel,
  InvokeChannels,
  PlanDecision,
  AskRequest,
  ConfirmRequest,
  PlanRequest,
  SessionValue,
  UiEffect,
} from '../shared/ipc.js';

/** `--mock` / `--project <dir>` (also `--project=<dir>`) / `--smoke`, from the app's own argv. */
interface CliArgs {
  mock: boolean;
  project?: string;
  /** Resolve the two external SDKs, say so, and exit. See `./smoke.ts`. */
  smoke: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let mock = false;
  let project: string | undefined;
  let smoke = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--mock') mock = true;
    else if (arg === '--smoke') smoke = true;
    else if (arg === '--project') project = argv[++i];
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
  }
  return { mock, project, smoke };
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
 * Every window onto this workspace. A window is a view: one process, one session, one command
 * stack, one project, N renderers. See `./windows.ts` for why the registry itself may not
 * import `electron`.
 */
const windows = new Windows<BrowserWindow>();
let session: WorkspaceSession | null = null;
let stack: CommandStack<CommandHost> | null = null;
let sessionState: SessionState | null = null;
/** The lock on the open project — one instance per workspace (`./instancelock.ts`). */
let instanceLock: InstanceLock | null = null;

const pendingPlans = new Pending<PlanDecision>({ approved: false });
/**
 * An abandoned form yields no answers rather than guessed ones, and an abandoned confirmation
 * counts as a refusal. The abandoned value is an empty array rather than one blank per question
 * because `answersFor` pads it out to the form the loop still holds.
 */
const pendingAsks = new Pending<string[]>([]);
const pendingConfirms = new Pending<boolean>(false);

/** End every parked turn when nobody is left to ask, rather than leaving one blocked forever. */
function abandonPending(): void {
  pendingPlans.abandon();
  pendingAsks.abandon();
  pendingConfirms.abandon();
}

/** One window closed. Only the turns parked on that window end; the others are still asked. */
function abandonPendingBy(id: WindowId): void {
  pendingPlans.by(id);
  pendingAsks.by(id);
  pendingConfirms.by(id);
}

/**
 * Resolve a push's destination. Pushes to the named window if it still exists. Otherwise pushes
 * to the focused window, or to the most recently focused window if none is focused. Targeted
 * pushes resolve through here too, so a window that closed between the command starting and the
 * effect landing cannot swallow the answer.
 */
function windowFor(target?: WindowId): BrowserWindow | undefined {
  const named = target === undefined ? undefined : windows.get(target);
  return named ?? windows.focusedHandle();
}

/** Send a process-wide fact to every window, as opposed to an answer to one window's question. */
function broadcast<C extends EventChannel>(channel: C, payload: EventChannels[C]): void {
  for (const { handle } of windows.all()) handle.webContents.send(channel, payload);
}

/**
 * Stamp what a write touched, tell every window, and answer the versions those documents now
 * carry. Every write path in the app funnels through here, so a pane weighing an echo sees the
 * agent's writes and another window's writes on the same terms as its own.
 *
 * Broadcast rather than answered to the window that asked: a `ui` command in one window used to
 * reach no other window at all, because `undoRevision` only advances for a restore or for a
 * mutating record from somewhere other than the UI.
 */
function noteWrites(paths: readonly string[]): DocVersions {
  if (paths.length === 0) return {};
  const versions = liveDocs.wrote(paths);
  // Directly rather than through `getSession()`, which would build a session on a path whose only
  // job is to report a write that has already happened.
  session?.forgetGraphDocs(paths);
  broadcast('documents:wrote', { paths: [...paths], versions });
  return versions;
}

/** Send an answer to the one window that asked the question. */
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
 * from. The two live in different trees on purpose: `templates/basic` is committed and the whole
 * of `examples/` is gitignored, so a seeded workspace cannot dirty the checkout. A source
 * checkout is detected by the presence of the template — `examples/` is ignored, so a fresh
 * clone has none — and a packaged build, having neither, puts the scratch workspace under
 * `userData`, where a failure is reported by name rather than as a bare ENOENT downstream.
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
 * A native directory dialog asking the user to pick the project's directory, shown on a first
 * run only. A folder that cannot be opened is reported and asked again rather
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
 * Resolve the workspace once, before anything can ask for it. `--project` (or `VN_PROJECT`) wins
 * when it is given. Otherwise the most recent project that still exists is opened, failing that
 * the picker is shown, and the seeded sample is the last resort.
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
  const recent = recentWorkspaces(getSessionState()).find((dir) => existsSync(dir));
  if (recent) {
    workspaceRoot = recent;
    return;
  }
  const picked = process.env.VN_NO_PICKER === '1' ? undefined : await promptForWorkspace();
  workspaceRoot = picked ?? (await seedSample());
}

/** The project's name, remembered so a window opened later can be titled like the rest. */
let projectTitle = '';

/**
 * Name every window after the project. The header shows the title too, but the taskbar and the
 * window switcher show only the window title, and three windows all called `vnstudio` cannot be
 * told apart.
 *
 * Identical project titles have the same problem, so each title gains a ` (n)` suffix while
 * more than one window is open, and loses it again when only one is left.
 */
function nameWindows(title: string = projectTitle): void {
  projectTitle = title;
  const base = title ? `${title} — vnstudio` : 'vnstudio';
  const open = windows.all();
  for (const { id, handle } of open) {
    handle.setTitle(open.length > 1 ? `${base} (${id + 1})` : base);
  }
}

/**
 * Open a different project without restarting. Everything workspace-shaped in this module is a
 * singleton, so all of it is dropped: the session (with its agent conversation), the command
 * stack and its undo journal, the repo map, and the undo revision. Undo never crosses a
 * workspace boundary, and nothing may cache the root across this call.
 */
async function switchWorkspace(root: string): Promise<{ root: string; title: string }> {
  // Acquire the new root before releasing the old one, so a switch never drops a lock it might
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
  // After the last step that can throw, and before both `suspend()` and the root moving: a batch
  // that failed to commit files a notification, which belongs to the project it was edited in.
  await stack?.dispose();
  // A turn parked on a question ends here, because nobody is left to answer it once the workspace switches.
  abandonPending();
  notifications().suspend();
  workspaceRoot = opened.root;
  session = null;
  stack = null;
  // A recompute scheduled by the project being left would read the new project's order key and
  // write the old project's hashes into it.
  if (approvalTimer) clearTimeout(approvalTimer);
  approvalTimer = null;
  broadcastApprovals = [];
  ownedRepos.length = 0;
  // The stack and its undo history are rebuilt against the new root, so nothing held may cross.
  forgetFiles();
  // Versions are keyed workspace-relative, so under a different root the same key names a
  // different file and a stale count would tell a pane its copy was current.
  liveDocs.clear();
  undoRevision = 0;
  await openRepos();
  // Before any window is told about the switch, so the arrangement of the project being left is
  // flushed and the reload below reads the new project's own file.
  await getSessionState().openProject(opened.root);
  rememberWorkspace(getSessionState(), opened.root);
  // Pushed directly rather than through the command host: the stack that is running the command
  // asking for this switch is the one being discarded. It reaches whichever windows have not
  // reloaded yet; the rest re-read the project at boot.
  broadcast('command:ui', { type: 'workspace', root: opened.root, title: opened.title });
  // Every window remounts — the workspace is process-wide, so opening another project tears all
  // of them down. A reload re-runs the boot path, which is what restores this project's layout,
  // template and selection. Building a new mesh under the live one instead would leave the
  // removed screen holding its window listeners and answering the pointer from underneath.
  for (const { id, handle } of windows.all()) loadWindow(handle, id);
  nameWindows(opened.title);
  return { root: opened.root, title: opened.title };
}

/**
 * The repos the app may write history in — the project's, plus the story bible's when `wiki/`
 * is its own. Resolved once, after the workspace exists.
 *
 * A repo appears here only when the directory is its own root. A project opened inside a larger
 * repo (a checkout of this monorepo, say) resolves to that repo, and committing `-A` there
 * would sweep in files that have nothing to do with the project — so commit-on-save stays off
 * rather than guessing at a scope. Undo is unaffected: it snapshots a directory, not a repo.
 */
const ownedRepos: Git[] = [];

/**
 * Bring the workspace under version control, then record anything changed outside the app as
 * its own event — a CLI run, another editor. Recording those changes first establishes the
 * invariant every later commit relies on: the app opens on a clean worktree, and every act ends
 * with one.
 */
async function openRepos(): Promise<void> {
  const root = workspace();
  // Written whatever git can do, because these are files the app needs rather than history: only
  // committing them wants a repository. `openWorkspace` runs the same pair, but it runs only for
  // an explicit `workspace.open` — a project reached from the recents list or `VN_PROJECT` gets
  // its layout templates, its merge attribute and its ignore line here.
  const scaffolded = await writeScaffolding(root);
  // Everything down to the sweep spawns `git`, and on a machine without it the first call
  // would throw before any window exists, so the app would never appear. Branching on the
  // doctor's finding beats a try/catch, which would have to guess which failures mean "no git".
  if (gitHealth().ok) {
    await ensureRepo(root);
    const refs = await new Workspace(root).repos();
    for (const ref of refs) {
      if (ref.owned) ownedRepos.push(openGit(ref.root));
      else console.warn(`[vnstudio] ${ref.role} sits inside ${ref.root}; not committing there`);
    }
    // Before the sweep, so what was just written lands under a subject saying what it is
    // rather than under "Changes made outside the app".
    await commitScaffolding(root, scaffolded);
    const committed = await committer().sweep('Changes made outside the app');
    for (const c of committed) {
      console.log(`[vnstudio] sweep ${c.sha.slice(0, 8)} in ${c.repo}`);
    }
  }
  // Opened only after the sweep: a notification written earlier would have been swept
  // into that commit under a subject that has nothing to do with it.
  await notifications().open();
  await noticeMissingGit();
  await noticeMissingKeys();
}

/**
 * Show the dialog once, before a window exists, so the first thing a stranger sees on a machine
 * without git is the reason rather than the symptom. Not fatal: the app opens anyway, because
 * someone who only wants to watch a generated VN should not need git to do it.
 */
async function askAboutGit(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Git was not found',
    message: 'Git was not found on this machine',
    detail: GIT_MISSING_MESSAGE,
    buttons: ['Download git', 'Continue without it'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await shell.openExternal(GIT_DOWNLOAD_URL);
}

/**
 * File the startup doctor's finding as a durable notification. The dialog has already said it,
 * but a dismissed modal leaves no trace, and this is the sort of news an author reads once and
 * then needs to find again a day later.
 */
async function noticeMissingGit(): Promise<void> {
  if (gitHealth().ok) return;
  const already = await notifications().list();
  if (already.some((note) => note.message === GIT_MISSING_MESSAGE)) return;

  await notifications().post({
    category: 'workspace',
    level: 'warn',
    source: 'main',
    message: GIT_MISSING_MESSAGE,
  });
}

/**
 * Say once, per project, that this install cannot call a model yet.
 *
 * A brand-new install looks healthy right up to the first run, which fails somewhere deep in a
 * task with a message about a provider. This notice states the same fact earlier and more plainly,
 * and links the pane that fixes it.
 *
 * Filed as a notification rather than shown as a dialog because a notification is durable: an
 * author who dismisses the note frame still has it in the bell. It is posted at most once per
 * project, guarded by the notification log itself, because nothing else remembers. Under `--mock`
 * there is nothing to warn about, since a mock run calls no provider.
 */
async function noticeMissingKeys(): Promise<void> {
  if (MOCK) return;
  const view = await getSession()
    .keyStatusView()
    .catch(() => undefined);
  const missing = view?.vendors.filter((vendor) => !vendor.resolved) ?? [];
  if (missing.length === 0) return;

  // Posted once per project, whether or not it was read: the notification log is the only
  // record of having said it, so the guard reads the log.
  const already = await notifications().list();
  if (already.some((note) => note.link?.editor === 'onboarding')) return;

  await notifications().post({
    category: 'workspace',
    level: 'warn',
    source: 'main',
    message:
      `No API key for ${missing.map((vendor) => vendor.vendor).join(' or ')}, so anything that ` +
      `needs ${missing.length > 1 ? 'them' : 'it'} fails at the first call. Setup has the steps.`,
    link: { editor: 'onboarding' },
  });
}

function committer(): Committer {
  return new Committer({ repos: () => ownedRepos });
}

/**
 * The notification hub. Installed at module load and dormant until `openRepos` opens it, so
 * nothing reaches `vngen/state` before the open-time sweep has swept the worktree.
 *
 * The log path is resolved per post rather than captured — `switchWorkspace` replaces the root
 * under it, and a captured one would write into a directory `workspace.create` is about to
 * require to be empty.
 */
installNotifications({
  file: () => (workspaceRoot ? new ProjectPaths(workspaceRoot).notificationsLog : undefined),
  // Every window gets the whole note. The note frame is per-window chrome, so an author looking at
  // the other monitor should still see what happened, and every window's bell count stays current.
  push: (note) => broadcast('notify:changed', { note }),
});

/**
 * How long after a mutating command the approval list is recomputed. `approvable()` reloads and
 * reparses the whole project, so an agent turn making six edits in a row recomputes once.
 */
const APPROVAL_DEBOUNCE_MS = 150;

let approvalTimer: NodeJS.Timeout | null = null;

/** The hashes last pushed, so a recompute that changed nothing does not redraw every window. */
let broadcastApprovals: string[] = [];

/**
 * Recount what is waiting on approval, persist the order it is read in, and tell the windows when
 * the set has changed.
 *
 * Failures are logged rather than thrown. This runs detached from whichever command scheduled it,
 * so there is nobody left to answer, and a project that will not load mid-edit is not that
 * command's error to report.
 */
async function recomputeApprovals(): Promise<void> {
  if (!workspaceRoot) return;
  try {
    const previous = getSessionState().get<string[]>(APPROVAL_ORDER_KEY, []);
    const { order } = await getSession().approvalQueue(previous);
    getSessionState().set(APPROVAL_ORDER_KEY, order);
    if (sameApprovals(order, broadcastApprovals)) return;
    broadcastApprovals = order;
    broadcast('approval:changed', {});
  } catch (err) {
    console.warn(`[vnstudio] could not recount what is waiting on approval: ${String(err)}`);
  }
}

/** Coalesce a burst of commands into one recompute. */
function scheduleApprovals(): void {
  if (approvalTimer) return;
  approvalTimer = setTimeout(() => {
    approvalTimer = null;
    void recomputeApprovals();
  }, APPROVAL_DEBOUNCE_MS);
  approvalTimer.unref?.();
}

/**
 * The window that started the current agent turn, remembered from `agent:run`'s sender. There is
 * one conversation, so there is one in-flight turn — a plan prompt therefore has exactly one
 * right place to land. A turn started by anything but a window (CDP, a schedule) leaves this
 * undefined and the prompt goes to the focused window, like any other unaddressed push.
 */
let turnWindow: WindowId | undefined;

/**
 * Ask the window that started the turn, and focus it. `agent:event` broadcasts, so every
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

/**
 * What this build calls itself. A release says its version; anything built between releases says
 * the commit too, resolved once at startup because it costs a `git` call.
 */
let appVersion = app.getVersion();

const deps: SessionDeps = {
  emitEvent: (event) => {
    // An agent tool call is not a command and never reaches the stack, so its writes are stamped
    // here instead. Before the event goes out, so a pane cannot be told a tool ran and then be
    // told separately what it wrote.
    if (event.type === 'tool') noteWrites(event.result.written ?? []);
    broadcast('agent:event', event);
  },
  emitReport: (event) => broadcast('report:event', event),
  requestPlan: (plan) =>
    askWindow(pendingPlans, (id, target) => {
      const request: PlanRequest = { id, plan };
      target.webContents.send('permission:plan', request);
    }),
  requestAnswer: (questions) =>
    askWindow(pendingAsks, (id, target) => {
      const request: AskRequest = { id, questions: [...questions] };
      target.webContents.send('permission:ask', request);
    }),
  requestConfirm: (tool, detail) =>
    askWindow(pendingConfirms, (id, target) => {
      const request: ConfirmRequest = { id, tool, detail };
      target.webContents.send('permission:confirm', request);
    }),
  // A getter, not a value: the development build appends the commit, and that costs a `git`
  // call, which is not something a module-level object literal should be waiting on.
  get appVersion() {
    return appVersion;
  },
  userData: app.getPath('userData'),
  openExternal: (url) => shell.openExternal(url),
  writeClipboard: (text) => clipboard.writeText(text),
  pushBusy: (state) => broadcast('command:ui', { type: 'busy', ...state }),
  offerDiagnosis: (fault) =>
    broadcast('command:ui', { type: 'agent', action: 'diagnose', ...fault }),
};

function getSession(): WorkspaceSession {
  if (!session) {
    session = new WorkspaceSession(workspace(), MOCK, deps);
    // The one agent setting that outlives the run: what a turn may spend is a decision about
    // this machine's bill, so it is restored here rather than re-chosen every launch.
    session.budget = getSessionState().get<BudgetChoice>(BUDGET_KEY, DEFAULT_BUDGET);
  }
  return session;
}

/** Opened once during `app.whenReady()`, before any window can ask for its snapshot. */
function getSessionState(): SessionState {
  if (!sessionState) throw new Error('the session store is only available after app ready');
  return sessionState;
}

/**
 * Open the install-global store and the router over it. The project's own store is opened
 * separately, once the workspace root is known.
 *
 * Every write broadcasts, whoever made it and whichever file it lands in.
 */
async function openSessionStore(): Promise<void> {
  const notify = (key: string, value: SessionValue): void => {
    broadcast('session:changed', { key, value });
  };
  sessionState = new SessionState(await SessionStore.open(undefined, notify), notify);
}

const registry = createDesktopRegistry();

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
      state: getSessionState(),
      // A `view.*` effect is targeted at the window whose palette or menu ran the command.
      // `windowFor` falls back to the focused window for the agent, CDP and main.
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
      noteTurnWindow: (origin) => {
        turnWindow = origin;
      },
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
      // Undo still works where commit-on-save refuses: a snapshot is held in memory and writes
      // nobody's history, so a project nested in a larger repo is snapshotted like any other.
      journal: new UndoJournal({ root, store: snapshotStore, exclude: UNDO_EXCLUDES }),
      committer: committer(),
      // A held-back run of edits that could not be committed is the one commit-on-save failure an
      // author has to act on, so it is filed durably rather than logged. The edits are on disk and
      // the stack keeps the batch, so the next flush retries.
      onCommitError: (error, records) => {
        void notify({
          category: 'error',
          level: 'error',
          message: `${records.length} edit(s) (seq ${seqRanges(records.map((r) => r.seq))}) are saved but not committed: ${String(error)}`,
          source: 'ui',
        });
      },
      onRecord: async (record) => {
        // The revision tells the renderer that files moved without it moving them. An undo or redo
        // always counts, as does a mutating command from the agent, CDP or main, whose changes the
        // renderer never invalidated. A `ui` command is left out because `exec` already invalidated.
        if (record.stack || (record.mutating && record.source !== 'ui')) undoRevision++;
        // Before the log append, so a window is told a document moved as soon as the command that
        // moved it has finished writing rather than after the history behind it is durable. The
        // stamp is in place by the time `command:exec` reads it back, because this hook is
        // awaited inside the stack before the outcome is returned.
        noteWrites(record.written ?? []);
        await appendJsonl(paths.commandsLog, record);
        // Files every command's outcome, whoever ran it — the palette, a menu, the agent, CDP.
        // This one hook replaces a `say()` call at each of the thirty places that used to report
        // their own outcome. A refusal arrives as a throw, with `status: 'error'` and its reason.
        if (shouldFileCommand(record)) {
          await notify({
            category: record.status === 'ok' ? categoryOfCommand(record.id) : 'error',
            level: record.status === 'ok' ? 'info' : 'error',
            message: record.status === 'ok' ? record.message : (record.error ?? record.message),
            source: record.source === 'agent' || record.source === 'cdp' ? record.source : 'ui',
          });
        }
        // Scheduled rather than awaited: a recount reloads the project, and this hook sits on the
        // critical path of every command, including a one-line prose edit.
        // An undo restores files nobody edited through a command, so it counts as well.
        if (record.stack || record.mutating) scheduleApprovals();
        // Broadcast, because an undo is a fact about the worktree rather than an answer to one
        // window. Ctrl+Z in window B deliberately undoes an edit made in window A: undo restores a
        // snapshot of the whole worktree, so a per-window stack would misstate what it restores.
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
 * Tell the caller which version each document its command wrote now carries, so it can recognize
 * the echo of its own write. The versions are read rather than stamped: `onRecord` stamped them
 * and broadcast them already, and stamping again would hand the caller a version no window heard.
 */
function withVersions(outcome: ExecOutcome): ExecOutcome {
  const written = outcome.record?.written ?? [];
  return written.length === 0 ? outcome : { ...outcome, versions: liveDocs.current(written) };
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
  handle('workspace:skilltree', () => getSession().skillTree());
  handle('agent:run', (origin, input) => {
    // Remembered so a plan or a clarifying question lands where the turn was started.
    turnWindow = origin;
    return getSession().runAgent(input);
  });
  handle('agent:setMode', (_origin, mode) => getSession().setMode(mode));
  handle('agent:setModel', (_origin, modelId) => getSession().setModel(modelId));
  handle('agent:clear', () => getSession().clearAgent());
  handle('agent:system', () => getSession().systemPrompt());
  handle('plan:decision', (_origin, payload) => pendingPlans.answer(payload.id, payload.decision));
  handle('ask:answer', (_origin, payload) => pendingAsks.answer(payload.id, payload.answers));
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
  handle('gengraph:doc', (_origin, slug) => getSession().graphDoc(slug));

  // `catalogOf`, not a second `toCatalog` call: the two drifted, and the channel served a
  // catalog with no interactions while `commands.json` listed five.
  handle('command:catalog', () => catalogOf(registry));
  handle('command:exec', async (origin, request) => {
    const source = request.source ?? 'ui';
    if (request.dsl !== undefined) {
      return withVersions(await getStack().execDsl(request.dsl, source, origin));
    }
    if (request.id === undefined) {
      return { ok: false as const, error: 'command:exec needs an id or a dsl' };
    }
    return withVersions(await getStack().exec(request.id, request.props ?? {}, source, origin));
  });
  handle('command:check', (origin, request) =>
    getStack().check(request.id, request.props ?? {}, origin),
  );
  handle('command:history', (_origin, limit) => getStack().history(limit));
  handle('command:undo', () => getStack().undo());
  handle('command:redo', () => getStack().redo());

  handle('notify:list', () => notifications().list());
  handle('notify:post', (_origin, input) => notifications().post(input));

  // The read is also what remembers the order: a hash the stored order has not seen is new since
  // the list was last drawn, and stays on top until something reads past it.
  handle('approval:list', async () => {
    const previous = getSessionState().get<string[]>(APPROVAL_ORDER_KEY, []);
    const { items, order } = await getSession().approvalQueue(previous);
    getSessionState().set(APPROVAL_ORDER_KEY, order);
    return items;
  });

  handle('session:set', (_origin, payload) =>
    getSessionState().set(payload.key, payload.value, payload.scope),
  );
  // Synchronous on purpose (so the preload can hand the renderer its state before first
  // paint) and therefore registered directly: `handle` above is `ipcMain.handle`-only.
  ipcMain.on('session:snapshot:sync', (event) => {
    event.returnValue = getSessionState().snapshot();
  });
}

/**
 * Serve stored asset bytes to the renderer over `vnasset://<hash>.<ext>` — the app's only
 * image-loading path. The url host carries `<hash>.<ext>` (sha256 hashes are lowercase hex,
 * so the standard-scheme host lowercasing is harmless). A missing file simply fails the
 * request and the caller falls back to a placeholder.
 *
 * Both roots are searched, in the order `AssetStore` reads them: base art (portraits, model
 * sheets, location plates) lives beside the inputs at `assets/objects/`, and only shot frames are
 * under `vngen/build/assets/`. A url says nothing about which root it came from, and the
 * backlink panel's images are entirely the base kind (`docs/reference/asset-stores.md`).
 *
 * The root is resolved per request, not captured: after `switchWorkspace` a captured one would
 * serve the previous project's bytes at the new project's hashes.
 *
 * Bytes come from the file cache, which never has to revalidate them: a stored asset's name is
 * the hash of its own contents, so the file at a given path either holds those bytes or does not
 * exist. A request the cache answers touches no disk at all, which is what makes a gallery of
 * forty thumbnails redraw without forty reads.
 */
function registerAssetProtocol(): void {
  protocol.handle('vnasset', async (request) => {
    const host = new URL(request.url).hostname;
    const dot = host.lastIndexOf('.');
    const hash = dot > 0 ? host.slice(0, dot) : host;
    const ext = dot > 0 ? host.slice(dot + 1) : 'png';
    const paths = new ProjectPaths(workspace());
    for (const file of [paths.baseAssetFile(hash, ext), paths.assetFile(hash, ext)]) {
      const bytes = await fileCache.asset(file).catch(() => null);
      if (bytes) return new Response(bytes, { headers: { 'content-type': assetType(ext) } });
    }
    // A missing file simply fails the request, and the caller falls back to a placeholder.
    return new Response(null, { status: 404 });
  });
}

/** What `<img>` and `fetch` are told a stored asset is, from the extension its name carries. */
function assetType(ext: string): string {
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return known[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** The scope this workspace's windows stamp their session writes with. */
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
    // The cast crosses the JSON boundary: `RememberedWindow` is plain data all the way down, but
    // `SessionValue` is an index-signature type, and a named interface does not satisfy one.
    windowList = new WindowList((open) =>
      getSessionState().set(WINDOWS_KEY, open as unknown as SessionValue),
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
  const stored = getSessionState().snapshot()[WINDOWS_KEY];
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

/**
 * Point a window at the renderer, for the workspace open right now. A window knows its own index
 * and its workspace from its url: the preload can read `location.search` before first paint,
 * which is why `session.initial()` is `sendSync` at all, and for free the index lands in the CDP
 * target list, which is what makes `--window` work.
 *
 * Called again to reload a window after a workspace switch, which is why the url is built here
 * rather than inline in `createWindow`.
 */
function loadWindow(win: BrowserWindow, id: WindowId, options: NewWindowOptions = {}): void {
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

  loadWindow(win, id, options);

  win.on('focus', () => windows.touch(id));
  win.on('moved', rememberWindows);
  win.on('resized', rememberWindows);
  win.on('closed', () => {
    windows.remove(id);
    // Ends only this window's requests. With four windows open, ending every parked turn because
    // one closed would be a bug.
    abandonPendingBy(id);
    if (windows.size === 0) abandonPending();
    // Closing a window deliberately means it does not come back, so the list is rewritten from
    // what is left - unless a quit already froze it.
    getWindowList().rewrite(liveWindows());
    nameWindows();
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
    appVersion = describeVersion(app.getVersion(), {
      packaged: false,
      sha: await shortSha(app.getAppPath()),
    });
  }
  if (!gitHealth().ok) await askAboutGit();
  // The session store first: it is global per install, and it is where the recents list the
  // workspace is resolved from lives.
  await openSessionStore();
  await resolveWorkspace();

  // The lock is taken after the workspace resolves, deliberately: the root is not known until
  // then, and `resolveWorkspace` can put up an interactive picker, so an author may pick a repo
  // that turns out to be taken. VS Code also hands off after its picker.
  instanceLock = await acquireWorkspace(workspace(), focusFrontWindow);
  if (!instanceLock) {
    // Exit before creating any window, so the author sees the existing instance come forward
    // rather than a window that flashes and disappears.
    await focusOwner(workspace());
    app.exit(0);
    return;
  }

  // Before the first window, which reads its arrangement out of this file synchronously in its
  // preload.
  await getSessionState().openProject(workspace());
  await openRepos();
  rememberWorkspace(getSessionState(), workspace());
  registerAssetProtocol();
  registerIpc();

  // Before the first window, because a graph opened in one resolves its node types out of the
  // registry these activations land in. A refusal is filed as a notification rather than thrown,
  // so one bad plugin does not stop the app from opening.
  await activatePlugins();

  // Restore the arrangement this workspace was left in - each window at its own index, so each
  // one comes back into its own layout, selection and template rather than a default screen.
  const remembered = rememberedWindows();
  if (remembered.length === 0) createWindow();
  else for (const entry of remembered) createWindow({ bounds: entry.bounds });

  // The title is read from the workspace rather than remembered: the launch paths that skip
  // `openWorkspace` (`--project`, the recents branch) never learned it, and every path meets here.
  nameWindows((await inspectWorkspace(workspace())).title ?? '');
  app.on('activate', () => {
    if (windows.size === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quitting is synchronous, so hold it open for the two writes that may still be owed: the
// debounced session state, and a run of edits whose commit is deferred. Bounded either way,
// because losing a panel width or a commit subject is a smaller failure than a quit that never
// lands. 2000 covers a commit, which costs about 230 ms and does not grow with the project: the
// cost is git's own process startup rather than the size of the tree `-A` stages.
const QUIT_FLUSH_MS = 2000;
let flushingOnQuit = false;
app.on('before-quit', () => {
  // A quit closes every window in a cascade, and the `closed` handler rewrites the list from
  // what is left - so without this the arrangement would be rewritten down to nothing on the way
  // out. Snapshot the open set first, then stop writing for the rest of the process.
  if (boundsTimer !== undefined) clearTimeout(boundsTimer);
  if (sessionState && workspaceRoot) getWindowList().freeze(liveWindows());
});
app.on('before-quit', (event) => {
  if (flushingOnQuit) return;
  const state = sessionState;
  // Asked of the stack only where one exists, since `getStack()` would build one on the way out.
  const batch = stack?.flushCommits();
  if (!state && !batch) return;
  flushingOnQuit = true;
  event.preventDefault();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_MS).unref?.());
  // Awaited together and raced as one, since racing them separately against the deadline would
  // let the quit land the moment the faster of the two settled.
  const owed = Promise.all([state?.close().catch(() => {}), batch?.catch(() => {})]);
  void Promise.race([owed, deadline]).finally(() => app.quit());
});
