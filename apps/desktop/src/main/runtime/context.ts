/**
 * The mutable state shared across the main-process bootstrap modules, and the handful of
 * operations that only need that state (nothing session-, stack-, or window-creation-shaped).
 *
 * One instance is constructed once, in `index.ts`, and passed explicitly to every function in
 * `./windowmanager.ts`, `./sessionaccess.ts`, `./stack.ts`, `./ipc.ts`, `./workspacelifecycle.ts`
 * and `./bootstrap.ts` that needs it, the same way `WorkspaceSession` composes its own concern
 * classes. Passing it explicitly (rather than each module holding its own top-level `let`) keeps
 * the import graph acyclic: two modules that both need to read and write this state would
 * otherwise have to import each other.
 */
import type { BrowserWindow } from 'electron';
import { Committer, type CommandStack } from '@vn/commands';
import type { Git } from '@vn/git';
import type { CommandHost } from '../commands/index.js';
import { createDesktopRegistry } from '../commands/index.js';
import type { WorkspaceSession } from '../session.js';
import type { SessionState } from '../workspace/sessionstate.js';
import type { InstanceLock } from '../bootstrap/instancelock.js';
import { Pending, Windows, type WindowId, type WindowList } from './windows.js';
import { workspaceScope } from '../../shared/sessionkeys.js';
import type { EventChannel, EventChannels, PlanDecision, DocVersions } from '../../shared/ipc.js';
import { liveDocs } from '../workspace/livedocs.js';

export class AppContext {
  /**
   * Every window onto this workspace. A window is a view: one process, one session, one command
   * stack, one project, N renderers. See `./windows.ts` for why the registry itself may not
   * import `electron`.
   */
  readonly windows = new Windows<BrowserWindow>();

  session: WorkspaceSession | null = null;
  stack: CommandStack<CommandHost> | null = null;
  sessionState: SessionState | null = null;
  /** The lock on the open project — one instance per workspace (`./instancelock.ts`). */
  instanceLock: InstanceLock | null = null;

  workspaceRoot: string | null = null;
  /** The project's name, remembered so a window opened later can be titled like the rest. */
  projectTitle = '';

  /**
   * The repos the app may write history in — the project's, plus the story bible's when `wiki/`
   * is its own. Resolved once, after the workspace exists.
   *
   * A repo appears here only when the directory is its own root. A project opened inside a larger
   * repo (a checkout of this monorepo, say) resolves to that repo, and committing `-A` there would
   * sweep in files that have nothing to do with the project — so commit-on-save stays off rather
   * than guessing at a scope. Undo is unaffected: it snapshots a directory, not a repo.
   */
  readonly ownedRepos: Git[] = [];

  /**
   * The window that started the current agent turn, remembered from `agent:run`'s sender. There
   * is one conversation, so there is one in-flight turn — a plan prompt therefore has exactly one
   * right place to land. A turn started by anything but a window (CDP, a schedule) leaves this
   * undefined and the prompt goes to the focused window, like any other unaddressed push.
   */
  turnWindow: WindowId | undefined;

  /**
   * What this build calls itself. A release says its version; anything built between releases
   * says the commit too, resolved once at startup because it costs a `git` call.
   */
  appVersion: string;

  /** Counts undo/redo moves, so a room knows when the files changed under it. */
  undoRevision = 0;

  windowList: WindowList | null = null;
  boundsTimer: ReturnType<typeof setTimeout> | undefined;

  approvalTimer: NodeJS.Timeout | null = null;
  /** The hashes last pushed, so a recompute that changed nothing does not redraw every window. */
  broadcastApprovals: string[] = [];

  readonly pendingPlans = new Pending<PlanDecision>({ approved: false });
  /**
   * An abandoned form yields no answers rather than guessed ones, and an abandoned confirmation
   * counts as a refusal. The abandoned value is an empty array rather than one blank per question
   * because `answersFor` pads it out to the form the loop still holds.
   */
  readonly pendingAsks = new Pending<string[]>([]);
  readonly pendingConfirms = new Pending<boolean>(false);

  readonly registry = createDesktopRegistry();

  constructor(appVersion: string) {
    this.appVersion = appVersion;
  }

  /** The resolved workspace. Only callable after `resolveWorkspace()` has run. */
  workspace(): string {
    if (!this.workspaceRoot) throw new Error('the workspace is only available after app ready');
    return this.workspaceRoot;
  }

  /** Opened once during `app.whenReady()`, before any window can ask for its snapshot. */
  getSessionState(): SessionState {
    if (!this.sessionState) throw new Error('the session store is only available after app ready');
    return this.sessionState;
  }

  /**
   * Resolve a push's destination. Pushes to the named window if it still exists. Otherwise pushes
   * to the focused window, or to the most recently focused window if none is focused. Targeted
   * pushes resolve through here too, so a window that closed between the command starting and the
   * effect landing cannot swallow the answer.
   */
  windowFor(target?: WindowId): BrowserWindow | undefined {
    const named = target === undefined ? undefined : this.windows.get(target);
    return named ?? this.windows.focusedHandle();
  }

  /** Send a process-wide fact to every window, as opposed to an answer to one window's question. */
  broadcast<C extends EventChannel>(channel: C, payload: EventChannels[C]): void {
    for (const { handle } of this.windows.all()) handle.webContents.send(channel, payload);
  }

  /** Send an answer to the one window that asked the question. */
  sendTo<C extends EventChannel>(
    target: WindowId | undefined,
    channel: C,
    payload: EventChannels[C],
  ): void {
    this.windowFor(target)?.webContents.send(channel, payload);
  }

  /** The scope this workspace's windows stamp their session writes with. */
  scope(): string {
    return workspaceScope(this.workspace());
  }

  committer(): Committer {
    return new Committer({ repos: () => this.ownedRepos });
  }

  /** End every parked turn when nobody is left to ask, rather than leaving one blocked forever. */
  abandonPending(): void {
    this.pendingPlans.abandon();
    this.pendingAsks.abandon();
    this.pendingConfirms.abandon();
  }

  /** One window closed. Only the turns parked on that window end; the others are still asked. */
  abandonPendingBy(id: WindowId): void {
    this.pendingPlans.by(id);
    this.pendingAsks.by(id);
    this.pendingConfirms.by(id);
  }

  /**
   * Ask the window that started the turn, and focus it. `agent:event` broadcasts, so every window
   * shows the agent thinking, and a prompt that landed unfocused on the other monitor would read
   * as a hung turn on the one the author is actually looking at. A window that went away mid-turn
   * falls back to the focused one rather than parking forever.
   */
  askWindow<T>(pending: Pending<T>, send: (id: number, win: BrowserWindow) => void): Promise<T> {
    const target = this.windowFor(this.turnWindow);
    if (!target) return Promise.resolve(pending.abandonedValue);
    const id = this.windows.byHandle(target);
    target.focus();
    return pending.ask((requestId) => send(requestId, target), id);
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
  noteWrites(paths: readonly string[]): DocVersions {
    if (paths.length === 0) return {};
    const versions = liveDocs.wrote(paths);
    // Directly rather than through `getSession()`, which would build a session on a path whose
    // only job is to report a write that has already happened.
    this.session?.forgetGraphDocs(paths);
    this.broadcast('documents:wrote', { paths: [...paths], versions });
    return versions;
  }
}
