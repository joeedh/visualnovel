/**
 * The questions the task list answers about itself, kept out of the editor because they are
 * inferences the editor got wrong.
 *
 * The list has four ways to hide a task and they overlap: `only done` keeps what finished
 * successfully, `only running` keeps what is moving right now, `only failed` keeps what stopped
 * and wants a person, and Clear finished takes what finished out. Clear's set is a superset of
 * `only done`'s, so an empty list has to be explained by asking about Clear first — otherwise a
 * list emptied by Clear blames the filter and tells the author nothing has finished at the exact
 * moment ten things have.
 */
import { refuse, type Offer } from './anchors.js';
import { publish, view, type Publishes } from './effects.js';
import { taskPublishes, type Selection } from './selection.js';
import type { Task } from '../../src/shared/ipc';

/** What the four controls are set to. Held by the pane; nothing here reads the pane. */
export interface ListFilter {
  /** Hashes taken out of the list by Clear finished. Nothing is deleted from `tasks.jsonl`. */
  cleared: ReadonlySet<string>;
  onlyDone: boolean;
  /**
   * Narrow to what is moving. Independent of {@link onlyDone} rather than a third state of one
   * control. `done` and `running` are disjoint, so ticking both keeps nothing, and
   * {@link emptyBecause} names the pair rather than one of them.
   */
  onlyRunning: boolean;
  /**
   * Narrow to what stopped and wants a person — both `failed` and `needs_human`.
   *
   * Two statuses under one tick, deliberately: they are one question for the author ("what went
   * wrong?"), and a shot that exhausted its refinement attempts is the most likely answer.
   */
  onlyFailed: boolean;
}

/** The statuses {@link ListFilter.onlyFailed} keeps. */
function stopped(task: Task): boolean {
  return task.status === 'failed' || task.status === 'needs_human';
}

/** Whether a task survives the status ticks. The statuses are disjoint, so two ticks keep none. */
function passesStatus(task: Task, filter: ListFilter): boolean {
  if (filter.onlyDone && task.status !== 'done') return false;
  if (filter.onlyRunning && task.status !== 'running') return false;
  if (filter.onlyFailed && !stopped(task)) return false;
  return true;
}

/** The tasks the list is showing: the filter's answer, minus whatever Clear took out of it. */
export function showing(tasks: readonly Task[], filter: ListFilter): Task[] {
  return tasks.filter((task) => !filter.cleared.has(task.hash) && passesStatus(task, filter));
}

/** The ticks that are on, by the word the checkbox uses. Empty when the list is unnarrowed. */
function ticked(filter: ListFilter): string[] {
  return [
    ...(filter.onlyDone ? ['done'] : []),
    ...(filter.onlyRunning ? ['running'] : []),
    ...(filter.onlyFailed ? ['failed'] : []),
  ];
}

/**
 * Why the list is empty, said in terms of the control that emptied it — so the sentence names
 * something the author can act on rather than the first guess that fits.
 */
export function emptyBecause(tasks: readonly Task[], filter: ListFilter): string {
  if (tasks.length === 0) return 'No tasks yet — run the pipeline.';
  if (!tasks.some((task) => !filter.cleared.has(task.hash)))
    return 'Everything is cleared out of this list. Refresh brings it back.';
  // More than one tick on asks for a task in two states at once, so the sentence names the pair
  // rather than blaming whichever tick is tested first
  const on = ticked(filter);
  if (on.length > 1) {
    return `No task is ${on.join(' and ')} at once — untick all but one of the ${on.length}.`;
  }
  if (filter.onlyFailed)
    return 'Nothing has failed or been flagged for a person — untick “only failed” to see the rest.';
  if (filter.onlyRunning) return 'Nothing is running — untick “only running” to see the rest.';
  return 'Nothing here has finished — untick “only done” to see the rest.';
}

/** What the Task List pane reads when it draws its bar, its gate bars and its cards. */
export interface TaskListState {
  /** The characters whose portrait approval the run is waiting on. */
  gatePending: string[];
  /** Whether a finished task is still in the list for Clear finished to take out; none when unset. */
  clearable?: boolean;
  /** The cards on screen, and the selection they are drawn against. */
  cards?: { tasks: readonly Task[]; selection: Selection };
}

/** The three status ticks, by the status each keeps. */
export type StatusTick = 'done' | 'running' | 'failed';

const TICK_SAYS: Record<StatusTick, string> = {
  done   : 'Narrow the list to the tasks that finished successfully.',
  running: 'Narrow the list to the tasks a wave is working on right now.',
  failed:
    'Narrow the list to what stopped and wants a person — failed tasks and shots flagged ' +
    'needs_human.',
};

/** One status tick. The filter is the pane's own, so flipping it is a view change. */
export function tickAction(tick: StatusTick): Offer {
  return {
    ok: true,
    ...view('filter'),
    on     : tick,
    label  : `only ${tick}`,
    tooltip: TICK_SAYS[tick],
  };
}

/**
 * Clear finished. Refused while nothing finished is left to take out, with the reason as its
 * sentence, since a greyed control that will not say why is the same bug as a hidden one.
 */
export function clearAction(clearable: boolean): Offer {
  const control = { ...view('filter'), on: 'clear', label: 'Clear finished' };
  if (!clearable) {
    return {
      ...refuse('Nothing finished is left in the list to take out of it.'),
      ...control,
      tooltip: 'Take everything already finished out of this list.',
    };
  }
  return {
    ok: true,
    ...control,
    tooltip:
      'Take everything already finished out of this list. Nothing is deleted — those records ' +
      'are what make a run resumable — and Refresh brings them back.',
  };
}

/** Refresh, which also undoes Clear finished. */
export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : 'Refresh',
    tooltip: 'Re-read what has run, what is running and what is ready, and undo Clear finished',
  };
}

/**
 * The asset hash a task left behind, whatever its status. `undefined` if it drew nothing.
 *
 * Bytes from a task that stopped are unusable downstream but still viewable, and a rejected
 * picture is what an author clicking a failed card is asking to see. A `needs_human` shot
 * carries its last rejected frame as `output`, and a `failed` task that got far enough to
 * render something carries it on the attempt that rendered it, so the last attempt with bytes
 * is the fallback. Nothing here accepts anything; the asset editor only displays.
 */
export function drewAsset(task: Task): string | undefined {
  if (task.output) return task.output;
  for (let i = task.attempts.length - 1; i >= 0; i--) {
    const drew = task.attempts[i]?.output;
    if (drew) return drew;
  }
  return undefined;
}

/**
 * What clicking a card does: publish the task and whatever it names, then put its picture on
 * screen where it drew one. The open goes through `view.open` rather than `ui.assetHash`, because
 * the command finds or raises the pane and records the act; `elsewhere` keeps this list standing.
 */
export function cardAction(task: Task, selection: Selection): Offer {
  const drew = drewAsset(task);
  return {
    ok: true,
    ...publish(taskPublishes(task, selection) as Publishes),
    on     : `task/${task.hash}`,
    label  : task.kind,
    tooltip: drew
      ? `Open what this ${task.kind} drew in the asset editor — the last frame it rendered, ` +
        'accepted or not; every other pane follows the pick'
      : `Inspect this ${task.kind} — it rendered nothing to open; every other pane follows the pick`,
    ...(drew
      ? {
          then: [
            { id: 'view.open', props: { editor: 'asset', where: 'elsewhere', subject: drew } },
          ],
        }
      : {}),
  };
}

/**
 * Start a run. A run spends money and writes assets, so it goes through the palette's form and
 * its confirmation rather than off a bare button.
 */
export function runAction(): Offer {
  return {
    ok     : true,
    id     : 'pipeline.run',
    props  : {},
    label  : '▸ Run',
    tooltip: 'Open the run form, where the flags are spelled out before anything is spent',
    form   : true,
  };
}

/** The gate bar's button: open the approval form for the one character the run is waiting on. */
export function gateAction(character: string): Offer {
  return {
    ok     : true,
    id     : 'gate.approve',
    props  : { characterId: character },
    on     : character,
    label  : 'RESOLVE →',
    tooltip: `Approve ${character}'s portrait, which is what the rest of the run is waiting on`,
    form   : true,
  };
}

/** Every offer the Task List pane draws from this module. */
export function controls(state: TaskListState): readonly Offer[] {
  const cards = state.cards;
  return [
    runAction(),
    ...state.gatePending.map(gateAction),
    tickAction('done'),
    tickAction('running'),
    tickAction('failed'),
    clearAction(state.clearable ?? false),
    reloadAction(),
    ...(cards ? cards.tasks.map((task) => cardAction(task, cards.selection)) : []),
  ];
}
