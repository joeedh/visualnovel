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
import { api } from '../api.js';
import type { AgentEvent, CommandOutcome, PropValue, UiEffect } from '../../src/shared/ipc.js';
import type { ShellApp } from './context.js';
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

/** Re-read the workspace: the project's name and the diagnostics the header counts. */
export async function refreshWorkspace(): Promise<void> {
  const index = await api.invoke('workspace:index');
  const ui = shell().ui;
  ui.projectTitle = index.title ?? '';
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
 * plus an undo or a redo, which restores files no command in this session ran. Coarser than
 * {@link onExec} on purpose — a surface that redraws the whole workspace wants the union of the
 * two, and re-deriving it from the exec feed alone would miss the undo half entirely.
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
  if (!outcome.ok) say(outcome.error, true);
  for (const watcher of watchers) watcher(id, outcome);
  if (outcome.ok) wrote(outcome.record.written ?? []);
  if (outcome.ok && outcome.record.mutating) invalidate();
  return outcome;
}

/**
 * Undo or redo. A refusal is the interesting outcome: undo declines rather than guessing when
 * the worktree drifted, and the author has to be told why.
 */
export async function move(direction: 'undo' | 'redo'): Promise<void> {
  const outcome = await api.invoke(direction === 'undo' ? 'command:undo' : 'command:redo');
  if (outcome.ok) say(outcome.record?.message ?? `${direction} ok`);
  else say(outcome.error, true);
}

/**
 * Quit. `Menu.setApplicationMenu(null)` took the stock Ctrl+Q with it, so the shell owns the
 * gesture — and `window.close()` is the right way to spend it: it runs the same `beforeunload`
 * guard the window's own close button does, so an unsaved draft still gets asked about.
 */
export function quit(): void {
  window.close();
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
    shell().ui.model = modelId;
    touch();
  }
}

/** `default` is the absence of the knob, and it is the value the command and the state both use. */
export async function setEffort(effort: string): Promise<void> {
  if ((await exec('agent.setEffort', { effort })).ok) {
    shell().ui.effort = effort;
    touch();
  }
}

/**
 * Subscribe to what main pushes, and take the first workspace read. Called once, after the
 * screen exists — `say` and the palette both need one.
 */
export function installBridge(app: ShellApp): void {
  host = app;

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
      say(`Opened ${effect.title}`);
      void refreshWorkspace();
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
      // command, so `exec` never sees it and `onInvalidate` never fires.
      wrote(event.result.written ?? []);
    }
  });

  void refreshWorkspace();
}
