/**
 * The shell's one seam to the main process. Everything the header shows is pushed from here
 * into `ShellState`, and every action a widget takes leaves as a command over `command:exec`, so
 * the registry stays the only write path and no widget reaches a bespoke IPC channel.
 *
 * The state lives in this one module holding one `ShellApp` because a path.ux widget reads its
 * context rather than its props, so there is nothing to thread it through.
 */
import { message as note, error as noteError } from 'pathux';
import {
  DEFAULT_BUDGET,
  EFFORT_CHOICES,
  resolveEffort,
  type BudgetChoice,
  type EffortChoice,
} from '@vn/types';
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
import { seedReport } from './reportconvo.js';
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
 * which main would otherwise never hear about. Nothing is shown from here: main pushes every
 * notification back over `notify:changed`, and that push is what displays it.
 */
export function notify(input: NotificationInput): void {
  // The failure is swallowed rather than shown. With no project open there is no log to file it
  // in, and a browser preview has no main process at all.
  void api.invoke('notify:post', { source: 'ui', ...input }).catch(() => {});
}

/**
 * Say what a command answered, without saying it twice. Main files every act and every failure it
 * heard about and pushes them back, and that push is already displayed. The shell reports the
 * rest: a read that succeeded, and the handful of failures the stack rejects before a record
 * exists (an unknown command, bad props, a declined confirm).
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
 * Watch what the shell runs. This covers state a command changes that no push reports, such as the
 * agent's transcript. A surface follows the command rather than the button on it, so the palette
 * running the same id has the same effect.
 */
export function onExec(watcher: ExecWatcher): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

const invalidators = new Set<() => void>();

/**
 * Watch for the project on disk having moved: a mutating command that succeeded, an undo or a redo
 * (which restores files no command in this session ran), and an agent tool call that reported
 * having written something. Coarser than {@link onExec} on purpose, because a surface that redraws
 * the whole workspace wants the union of the three, and re-deriving it from the exec feed alone
 * would miss both the undo half and the agent entirely.
 *
 * The agent case makes a tool's `written` load-bearing rather than informational: the `agent:event`
 * fires this only when `written` is non-empty, so a mutating tool that reports nothing leaves every
 * tree in the app showing the state before it ran.
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
 * Watch which files moved. Neither {@link onExec} nor {@link onInvalidate} answers that, and
 * neither sees the agent at all — its writes never pass through `exec`, they arrive as
 * `agent:event` tool results carrying `ToolResult.written`. Both feed this, so an editor showing a
 * document follows that document whoever rewrote it.
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
 * Watch a run's progress. This is the one signal that moves while something is in flight: a
 * command's outcome (and so {@link onInvalidate}) arrives only once the run it started has
 * finished, so a pane showing what is running right now has nothing else to follow.
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
 * Ask a command whether it would run, without running it. The palette's form and the tree's
 * right-click menus use this too, so a surface that wants the refusal before the click gets the
 * command's own sentence rather than an invented one.
 */
export function check(id: string, props: Record<string, PropValue> = {}): Promise<CommandCheck> {
  return api.invoke('command:check', { id, props });
}

/**
 * Undo or redo. Undo declines rather than guessing when the worktree drifted, and the author has
 * to be told why. A refusal here carries no record, because the stack answers before it writes
 * one, so `report` is what displays it.
 */
export async function move(direction: 'undo' | 'redo'): Promise<void> {
  report(await api.invoke(direction === 'undo' ? 'command:undo' : 'command:redo'));
}

/**
 * Quit the app, and close just this window.
 *
 * Both go through main. A renderer-side `window.close()` would close only the window that asked
 * and leave the others up; main closes them all, and each still runs its own
 * `will-prevent-unload`, so an unsaved draft in each window is still asked about.
 */
export async function quit(): Promise<void> {
  report(await exec('window.quit'));
}

export async function closeWindow(): Promise<void> {
  report(await exec('window.close'));
}

/**
 * Mode and model are the two session facts no `command:ui` effect reports. `agent.setMode` does
 * emit an `agent:event`, but the model does not, so both are mirrored from the command's outcome
 * rather than left to a push that may not come.
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

/**
 * Mirror a binding main changed on its own. Reopening a saved conversation puts the agent back on
 * the model and effort that conversation was had on, and nothing pushes that — so the bar would
 * otherwise name the model of the conversation the author just left.
 */
export function noteBinding(model?: string, effort?: string): void {
  const ui = shell().ui;
  if (model) ui.model = model;
  if (effort && (EFFORT_CHOICES as readonly string[]).includes(effort)) {
    ui.effort = effort as EffortChoice;
  }
  touch();
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
  // budget in force instead of showing the default and then correcting it.
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
      // An undo or redo wrote files no editor here asked to write, so the whole surface is stale.
      // This effect is pushed after every command though, and only `revision` tells the two apart:
      // an ordinary command already invalidated from `exec` and would otherwise count twice.
      void refreshWorkspace();
      if (effect.revision !== revision) {
        revision = effect.revision;
        invalidate();
      }
      touch();
    } else if (effect.type === 'workspace') {
      // Nothing is said here. Whichever command opened the workspace is mutating, so main filed
      // its sentence and pushed it back; this effect only means re-read the current project.
      void refreshWorkspace();
    } else if (effect.type === 'busy') {
      ui.busyWhat = effect.what ?? '';
      ui.busyRan = effect.ran;
      ui.busyPending = effect.pending;
      const state: BusyState = { what: ui.busyWhat, ran: effect.ran, pending: effect.pending };
      for (const watcher of busyWatchers) watcher(state);
      touch();
    } else if (effect.type === 'agent' && effect.action === 'diagnose') {
      // The API rejected what was sent rather than being unreachable, so the request itself is the
      // evidence, and it lives only in this process until the ring rolls over. Both reading boxes
      // come ticked because this is the case they exist for; the author may untick either.
      void seedReport({
        ...(effect.thread ? { thread: effect.thread } : {}),
        source: true,
        detail: true,
        note:
          `The model API refused this turn: ${effect.message}

That is a fault in what was ` +
          'sent, not in the connection, so the debug agent is set up to read both the source and ' +
          'the requests this session sent. The requests stay on this machine — they are read on ' +
          'your own key, and nothing from them goes into the report.',
      });
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
    } else if (event.type === 'api') {
      // `retrying` is the only phase with a wait ahead of it. The other three are terminal — the
      // card going up, the call working, the turn giving up — so all of them clear the counter
      // rather than leaving a number nothing will move again.
      const counting = event.phase === 'retrying';
      app.ui.retryAttempt = counting ? event.attempt : 0;
      app.ui.retryOf = counting ? event.of : 0;
      touch();
    } else if (event.type === 'tool') {
      // A tool call is not a command, so `exec` never sees the agent's writes. Both feeds fire,
      // because a surface that redraws the whole workspace (the document tree) watches the coarse
      // one and would otherwise sit on a project the agent has since added a scene to.
      const written = event.result.written ?? [];
      wrote(written);
      if (written.length > 0) invalidate();
    }
  });

  // Main files every notification and pushes it back, so the transient sentence and the durable
  // record are one event: the bell recounts, an open list redraws, and the note frame shows it
  // once. A flag change carries no note, so the count changes but nothing new is said.
  api.on('notify:changed', (payload: { note?: Notification }) => {
    notificationsChanged();
    if (payload.note) say(payload.note.message, payload.note.level === 'error');
  });

  void refreshWorkspace();
  void refreshNotifications();
}
