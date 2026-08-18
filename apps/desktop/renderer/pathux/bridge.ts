/**
 * The shell's one seam to the main process. Everything the header shows is pushed from here
 * into `ShellState`; everything a widget *does* leaves as a command over `command:exec`, so
 * the registry stays the only write path and a widget never reaches a bespoke IPC channel.
 *
 * The React shell kept this state in `App.tsx`'s hooks and passed it down. Here it is one
 * module holding one `ShellApp`, because a path.ux widget reads its context rather than its
 * props — there is nothing to thread it through.
 */
import { message as note, error as noteError } from 'pathux';
import { DEFAULT_BUDGET, resolveEffort, type BudgetChoice, type EffortChoice } from '@vn/types';
import { api } from '../api.js';
import type {
  AgentEvent,
  CommandCheck,
  CommandOutcome,
  Notification,
  NotificationInput,
  PropValue,
  UiEffect,
} from '../../src/shared/ipc.js';
import { shouldFileCommand } from '../../src/shared/notify.js';
import type { ShellApp } from './context.js';
import { notificationsChanged, refreshNotifications } from './notifications.js';
import { closePalette, openPalette } from './palette.js';
import { applyView } from './view.js';

let host: ShellApp | undefined;

/** The last undo/redo move seen, so the effect pushed after every command can be told apart. */
let revision = 0;

/** The shell, once it exists. Throws rather than returning a half-built one. */
export function shell(): ShellApp {
  if (!host) throw new Error('the bridge is not installed yet');
  return host;
}

/**
 * Wake every widget bound to `ui.*`. The header rebuilds off the same push, so a state change
 * and a repaint are one act rather than a poll.
 */
function touch(): void {
  host?.api.notifyChange();
}

/** A one-line, self-clearing message in the screen's note frame. */
export function say(text: string, bad = false): void {
  const screen = host?.screen;
  if (!screen) return;
  if (bad) noteError(screen, text, 4000);
  else note(screen, text, 4000);
}

/**
 * File a notification the shell raised on its own — a notice that is not a command's outcome,
 * which main would otherwise never hear about. It is *not* shown from here: main pushes every
 * notification back over `notify:changed`, and that is what says it.
 */
export function notify(input: NotificationInput): void {
  // Swallowed rather than shown: with no project open there is no log to file it in, and a
  // browser preview has no main process at all. Neither is worth a second failure on screen.
  void api.invoke('notify:post', { source: 'ui', ...input }).catch(() => {});
}

/**
 * Say what a command answered, **without saying it twice**. Main files every act and every
 * failure it heard about and pushes them back, and that push is already displayed; what the
 * shell still has to voice is the rest — a read that succeeded, and the handful of failures the
 * stack rejects before a record exists (an unknown command, bad props, a declined confirm).
 */
export function report(outcome: CommandOutcome): void {
  if (!outcome.ok) {
    if (!outcome.record) say(outcome.error, true);
    return;
  }
  if (!shouldFileCommand(outcome.record)) say(outcome.record.message);
}

/** Re-read the workspace: the project's name and the diagnostics the header counts. */
export async function refreshWorkspace(): Promise<void> {
  const index = await api.invoke('workspace:index');
  const ui = shell().ui;
  ui.projectTitle = index.title ?? '';
  ui.projectRoot = index.root ?? '';
  // Errors displace warnings in the badge, so the two are counted apart and the worse one wins.
  ui.errors = index.diagnostics.filter((d) => d.severity === 'error').length;
  ui.warnings = index.diagnostics.length - ui.errors;
  touch();
}

type ExecWatcher = (id: string, outcome: CommandOutcome) => void;

const watchers = new Set<ExecWatcher>();

/**
 * Watch what the shell runs. For state a command changes that no push reports — the agent's
 * transcript is the one — so a surface follows the *command* rather than the button on it, and
 * the palette running the same id has the same effect.
 */
export function onExec(watcher: ExecWatcher): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

const invalidators = new Set<() => void>();

/**
 * Watch for "the project on disk may have moved under you": any mutating command that succeeded,
 * an undo or a redo, which restores files no command in this session ran, **and any agent tool
 * call that reported having written something**. Coarser than {@link onExec} on purpose — a
 * surface that redraws the whole workspace wants the union of the three, and re-deriving it from
 * the exec feed alone would miss both the undo half and the agent entirely.
 *
 * That last one makes a tool's `written` load-bearing rather than informational: the `agent:event`
 * handler below fires this only when it is non-empty, so a mutating tool that reports nothing
 * leaves every tree in the app showing the state before it ran.
 */
export function onInvalidate(listener: () => void): () => void {
  invalidators.add(listener);
  return () => invalidators.delete(listener);
}

function invalidate(): void {
  for (const listener of invalidators) listener();
}

type WroteWatcher = (paths: readonly string[]) => void;

const scribes = new Set<WroteWatcher>();

/**
 * Watch *which* files moved. Neither {@link onExec} nor {@link onInvalidate} answers that, and
 * neither sees the agent at all — its writes never pass through `exec`, they arrive as
 * `agent:event` tool results carrying `ToolResult.written`. Both feed this, so an editor showing a
 * document follows it whoever rewrote it.
 */
export function onWrote(watcher: WroteWatcher): () => void {
  scribes.add(watcher);
  return () => scribes.delete(watcher);
}

function wrote(paths: readonly string[]): void {
  if (paths.length === 0) return;
  for (const watcher of scribes) watcher(paths);
}

/** What a run has done so far, as the busy push reports it. */
export interface BusyState {
  what: string;
  ran: number;
  pending: number;
}

const busyWatchers = new Set<(state: BusyState) => void>();

/**
 * Watch a run's progress. The one signal that moves *while* something is in flight: a command's
 * outcome — and so {@link onInvalidate} — arrives only once the run it started has finished, so a
 * pane that wants to show what is running right now has nothing else to follow.
 */
export function onBusy(listener: (state: BusyState) => void): () => void {
  busyWatchers.add(listener);
  return () => busyWatchers.delete(listener);
}

/**
 * Run a command. Every mutating surface in the shell goes through this — the header's menu,
 * the palette, and whatever an editor offers — so provenance, undo and history are identical
 * whoever ran it.
 */
export async function exec(
  id: string,
  props: Record<string, PropValue> = {},
): Promise<CommandOutcome> {
  const outcome = await api.invoke('command:exec', { id, props, source: 'ui' });
  if (!outcome.ok && !outcome.record) say(outcome.error, true);
  for (const watcher of watchers) watcher(id, outcome);
  if (outcome.ok) wrote(outcome.record.written ?? []);
  if (outcome.ok && outcome.record.mutating) invalidate();
  return outcome;
}

/**
 * Ask a command whether it would run, without running it. The same door the palette's form and
 * the tree's right-click menus use, so a surface that wants the refusal *before* the click gets
 * the command's own sentence rather than one it invented.
 */
export function check(id: string, props: Record<string, PropValue> = {}): Promise<CommandCheck> {
  return api.invoke('command:check', { id, props });
}

/**
 * Undo or redo. A refusal is the interesting outcome: undo declines rather than guessing when
 * the worktree drifted, and the author has to be told why. A refusal here carries no record —
 * the stack answers before it writes one — so `report` is what voices it.
 */
export async function move(direction: 'undo' | 'redo'): Promise<void> {
  report(await api.invoke(direction === 'undo' ? 'command:undo' : 'command:redo'));
}

/**
 * Quit the app, and close just this window.
 *
 * Both go through main, and Quit having to is the bug the second window exposed: it was
 * `window.close()`, which closes the renderer that asked and leaves the others up — a Quit that
 * quits nothing. Main closes them all, and each still runs its own `will-prevent-unload`, so an
 * unsaved draft in *any* window is still asked about.
 */
export async function quit(): Promise<void> {
  report(await exec('window.quit'));
}

export async function closeWindow(): Promise<void> {
  report(await exec('window.close'));
}

/**
 * The two session facts no `command:ui` effect reports. `agent.setMode` does emit an
 * `agent:event`, but the model does not, so both are mirrored from the outcome rather than
 * left to a push that may not come.
 */
export async function toggleMode(): Promise<void> {
  const ui = shell().ui;
  const next = ui.agentMode === 'plan' ? 'execute' : 'plan';
  if ((await exec('agent.setMode', { mode: next })).ok) {
    ui.agentMode = next;
    touch();
  }
}

export async function setModel(modelId: string): Promise<void> {
  if ((await exec('agent.setModel', { modelId })).ok) {
    const ui = shell().ui;
    ui.model = modelId;
    // Main steps the bound effort down to what the new model takes; `resolveEffort` is pure and
    // shared, so mirroring it here reaches the same answer without a correction push.
    ui.effort = resolveEffort(modelId, ui.effort) ?? ui.effort;
    touch();
  }
}

export async function setEffort(effort: EffortChoice): Promise<void> {
  if ((await exec('agent.setEffort', { effort })).ok) {
    shell().ui.effort = effort;
    touch();
  }
}

export async function setBudget(budget: BudgetChoice): Promise<void> {
  if ((await exec('agent.setBudget', { budget })).ok) {
    shell().ui.budget = budget;
    touch();
  }
}

/**
 * Subscribe to what main pushes, and take the first workspace read. Called once, after the
 * screen exists — `say` and the palette both need one.
 */
export function installBridge(app: ShellApp): void {
  host = app;

  // The one agent setting main restores from the install's session file, so the bar paints the
  // budget in force rather than the default and then correcting itself.
  const storedBudget = api.session.initial()['agent.budget'];
  app.ui.budget =
    typeof storedBudget === 'string' ? (storedBudget as BudgetChoice) : DEFAULT_BUDGET;

  api.on('command:ui', (effect: UiEffect) => {
    const ui = app.ui;
    if (effect.type === 'palette') {
      if (effect.open) openPalette();
      else closePalette();
    } else if (effect.type === 'undo') {
      ui.canUndo = effect.state.canUndo;
      ui.canRedo = effect.state.canRedo;
      ui.undoLabel = effect.state.undoLabel ?? '';
      ui.redoLabel = effect.state.redoLabel ?? '';
      // An undo/redo wrote files no editor here asked to write, so the whole surface is stale.
      // This effect is pushed after *every* command though, and only `revision` tells the two
      // apart — an ordinary command already invalidated from `exec`, and would count twice.
      void refreshWorkspace();
      if (effect.revision !== revision) {
        revision = effect.revision;
        invalidate();
      }
      touch();
    } else if (effect.type === 'workspace') {
      // Nothing said here: whichever command opened it is mutating, so main filed its sentence
      // and pushed it back. This effect is only "re-read the project you are now in".
      void refreshWorkspace();
    } else if (effect.type === 'busy') {
      ui.busyWhat = effect.what ?? '';
      ui.busyRan = effect.ran;
      ui.busyPending = effect.pending;
      const state: BusyState = { what: ui.busyWhat, ran: effect.ran, pending: effect.pending };
      for (const watcher of busyWatchers) watcher(state);
      touch();
    } else if (effect.type === 'view') {
      // The command already said what it meant to do; the mesh answers only when it disagrees,
      // and that answer displaces the optimistic sentence rather than following it.
      const correction = applyView(app, effect);
      if (correction) say(correction, true);
      touch();
    }
  });

  api.on('agent:event', (event: AgentEvent) => {
    if (event.type === 'mode') {
      app.ui.agentMode = event.mode;
      touch();
    } else if (event.type === 'tool') {
      // The agent's half of "the files moved". Nothing else reports it: a tool call is not a
      // command, so `exec` never sees it. Both feeds fire, because a surface that redraws the whole
      // workspace — the document tree — watches the coarse one and would otherwise sit on a project
      // the agent has since added a scene to.
      const written = event.result.written ?? [];
      wrote(written);
      if (written.length > 0) invalidate();
    }
  });

  // Main files every notification and pushes it back, so the transient sentence and the durable
  // record are the same event: the bell recounts, an open list redraws, and the note frame shows
  // it once. A flag change carries no note — the count is stale, but nothing new was said.
  api.on('notify:changed', (payload: { note?: Notification }) => {
    notificationsChanged();
    if (payload.note) say(payload.note.message, payload.note.level === 'error');
  });

  void refreshWorkspace();
  void refreshNotifications();
}
