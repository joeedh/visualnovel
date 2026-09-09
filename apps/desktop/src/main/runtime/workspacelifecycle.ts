/**
 * Resolving, opening, and switching the workspace; the startup git/key notices; and the
 * debounced approvals recount. Everything here mutates `ctx.workspaceRoot`/`ctx.session`/
 * `ctx.stack`/`ctx.instanceLock` and the other process-wide singletons `AppContext` owns.
 */
import { app, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { openGit } from '@vn/git';
import { ProjectPaths } from '@vn/store';
import { Workspace } from '@vn/authoring';
import { installNotifications, notifications } from '../notify/notifications.js';
import { gitHealth, GIT_DOWNLOAD_URL, GIT_MISSING_MESSAGE } from '../bootstrap/doctor.js';
import { sameApprovals } from '../workspace/approvals.js';
import { acquireWorkspace, focusOwner } from '../bootstrap/instancelock.js';
import {
  commitScaffolding,
  ensureRepo,
  openWorkspace,
  recentWorkspaces,
  rememberWorkspace,
  seedWorkspace,
  writeScaffolding,
} from '../workspace/workspace.js';
import { forgetFiles } from '../workspace/filecache.js';
import { liveDocs } from '../workspace/livedocs.js';
import type { AppContext } from './context.js';
import { cliArgs, MOCK } from '../bootstrap/cliargs.js';
import { getSession } from './sessionaccess.js';
import { focusFrontWindow, loadWindow, nameWindows } from './windowmanager.js';
import { APPROVAL_ORDER_KEY } from '../../shared/sessionkeys.js';

/**
 * Installs the notification hub. Dormant until `openRepos` opens it, so nothing reaches
 * `vngen/state` before the open-time sweep has swept the worktree.
 *
 * The log path is resolved per post rather than captured — `switchWorkspace` replaces the root
 * under it, and a captured one would write into a directory `workspace.create` is about to
 * require to be empty.
 */
export function installAppNotifications(ctx: AppContext): void {
  installNotifications({
    file: () =>
      ctx.workspaceRoot ? new ProjectPaths(ctx.workspaceRoot).notificationsLog : undefined,
    // Every window gets the whole note. The note frame is per-window chrome, so an author
    // looking at the other monitor should still see what happened, and every window's bell
    // count stays current.
    push: (note) => ctx.broadcast('notify:changed', { note }),
  });
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
    title      : 'Open or create a VN project',
    buttonLabel: 'Open project',
    properties : ['openDirectory', 'createDirectory'],
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
export async function resolveWorkspace(ctx: AppContext): Promise<void> {
  const project = cliArgs.project ?? process.env.VN_PROJECT;
  if (project) {
    ctx.workspaceRoot = resolvePath(project);
    return;
  }
  const recent = recentWorkspaces(ctx.getSessionState()).find((dir) => existsSync(dir));
  if (recent) {
    ctx.workspaceRoot = recent;
    return;
  }
  const picked = process.env.VN_NO_PICKER === '1' ? undefined : await promptForWorkspace();
  ctx.workspaceRoot = picked ?? (await seedSample());
}

/**
 * Open a different project without restarting. Everything workspace-shaped in this module is a
 * singleton, so all of it is dropped: the session (with its agent conversation), the command
 * stack and its undo journal, the repo map, and the undo revision. Undo never crosses a
 * workspace boundary, and nothing may cache the root across this call.
 */
export async function switchWorkspace(
  ctx: AppContext,
  root: string,
): Promise<{ root: string; title: string }> {
  // Acquire the new root before releasing the old one, so a switch never drops a lock it might
  // then fail to reclaim. `check` may have said yes a moment ago and been overtaken since, which
  // is why this re-decides rather than trusting it.
  const target = resolvePath(root);
  const lock =
    resolvePath(ctx.workspaceRoot ?? '') === target
      ? ctx.instanceLock
      : await acquireWorkspace(target, () => focusFrontWindow(ctx));
  if (!lock) {
    await focusOwner(target);
    throw new Error(`${target} is already open in another window.`);
  }

  const opened = await openWorkspace(root);
  if (ctx.instanceLock && ctx.instanceLock !== lock) await ctx.instanceLock.release();
  ctx.instanceLock = lock;
  // After the last step that can throw, and before both `suspend()` and the root moving: a batch
  // that failed to commit files a notification, which belongs to the project it was edited in.
  await ctx.stack?.dispose();
  // A turn parked on a question ends here, because nobody is left to answer it once the workspace switches.
  ctx.abandonPending();
  notifications().suspend();
  ctx.workspaceRoot = opened.root;
  ctx.session = null;
  ctx.stack = null;
  // A recompute scheduled by the project being left would read the new project's order key and
  // write the old project's hashes into it.
  if (ctx.approvalTimer) clearTimeout(ctx.approvalTimer);
  ctx.approvalTimer = null;
  ctx.broadcastApprovals = [];
  ctx.ownedRepos.length = 0;
  // The stack and its undo history are rebuilt against the new root, so nothing held may cross.
  forgetFiles();
  // Versions are keyed workspace-relative, so under a different root the same key names a
  // different file and a stale count would tell a pane its copy was current.
  liveDocs.clear();
  ctx.undoRevision = 0;
  await openRepos(ctx);
  // Before any window is told about the switch, so the arrangement of the project being left is
  // flushed and the reload below reads the new project's own file.
  await ctx.getSessionState().openProject(opened.root);
  rememberWorkspace(ctx.getSessionState(), opened.root);
  // Pushed directly rather than through the command host: the stack that is running the command
  // asking for this switch is the one being discarded. It reaches whichever windows have not
  // reloaded yet; the rest re-read the project at boot.
  ctx.broadcast('command:ui', { type: 'workspace', root: opened.root, title: opened.title });
  // Every window remounts — the workspace is process-wide, so opening another project tears all
  // of them down. A reload re-runs the boot path, which is what restores this project's layout,
  // template and selection. Building a new mesh under the live one instead would leave the
  // removed screen holding its window listeners and answering the pointer from underneath.
  for (const { id, handle } of ctx.windows.all()) loadWindow(ctx, handle, id);
  nameWindows(ctx, opened.title);
  return { root: opened.root, title: opened.title };
}

/**
 * Bring the workspace under version control, then record anything changed outside the app as
 * its own event — a CLI run, another editor. Recording those changes first establishes the
 * invariant every later commit relies on: the app opens on a clean worktree, and every act ends
 * with one.
 */
export async function openRepos(ctx: AppContext): Promise<void> {
  const root = ctx.workspace();
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
      if (ref.owned) ctx.ownedRepos.push(openGit(ref.root));
      else console.warn(`[vnstudio] ${ref.role} sits inside ${ref.root}; not committing there`);
    }
    // Before the sweep, so what was just written lands under a subject saying what it is
    // rather than under "Changes made outside the app".
    await commitScaffolding(root, scaffolded);
    const committed = await ctx.committer().sweep('Changes made outside the app');
    for (const c of committed) {
      console.log(`[vnstudio] sweep ${c.sha.slice(0, 8)} in ${c.repo}`);
    }
  }
  // Opened only after the sweep: a notification written earlier would have been swept
  // into that commit under a subject that has nothing to do with it.
  await notifications().open();
  await noticeMissingGit();
  await noticeMissingKeys(ctx);
}

/**
 * Show the dialog once, before a window exists, so the first thing a stranger sees on a machine
 * without git is the reason rather than the symptom. Not fatal: the app opens anyway, because
 * someone who only wants to watch a generated VN should not need git to do it.
 */
export async function askAboutGit(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type     : 'warning',
    title    : 'Git was not found',
    message  : 'Git was not found on this machine',
    detail   : GIT_MISSING_MESSAGE,
    buttons  : ['Download git', 'Continue without it'],
    defaultId: 0,
    cancelId : 1,
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
    level   : 'warn',
    source  : 'main',
    message : GIT_MISSING_MESSAGE,
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
async function noticeMissingKeys(ctx: AppContext): Promise<void> {
  if (MOCK) return;
  const view = await getSession(ctx)
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
    level   : 'warn',
    source  : 'main',
    message:
      `No API key for ${missing.map((vendor) => vendor.vendor).join(' or ')}, so anything that ` +
      `needs ${missing.length > 1 ? 'them' : 'it'} fails at the first call. Setup has the steps.`,
    link    : { editor: 'onboarding' },
  });
}

/**
 * How long after a mutating command the approval list is recomputed. `approvable()` reloads and
 * reparses the whole project, so an agent turn making six edits in a row recomputes once.
 */
const APPROVAL_DEBOUNCE_MS = 150;

/**
 * Recount what is waiting on approval, persist the order it is read in, and tell the windows when
 * the set has changed.
 *
 * Failures are logged rather than thrown. This runs detached from whichever command scheduled it,
 * so there is nobody left to answer, and a project that will not load mid-edit is not that
 * command's error to report.
 */
async function recomputeApprovals(ctx: AppContext): Promise<void> {
  if (!ctx.workspaceRoot) return;
  try {
    const previous = ctx.getSessionState().get<string[]>(APPROVAL_ORDER_KEY, []);
    const { order } = await getSession(ctx).approvalQueue(previous);
    ctx.getSessionState().set(APPROVAL_ORDER_KEY, order);
    if (sameApprovals(order, ctx.broadcastApprovals)) return;
    ctx.broadcastApprovals = order;
    ctx.broadcast('approval:changed', {});
  } catch (err) {
    console.warn(`[vnstudio] could not recount what is waiting on approval: ${String(err)}`);
  }
}

/** Coalesce a burst of commands into one recompute. */
export function scheduleApprovals(ctx: AppContext): void {
  if (ctx.approvalTimer) return;
  ctx.approvalTimer = setTimeout(() => {
    ctx.approvalTimer = null;
    void recomputeApprovals(ctx);
  }, APPROVAL_DEBOUNCE_MS);
  ctx.approvalTimer.unref?.();
}
