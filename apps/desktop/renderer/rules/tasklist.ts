/**
 * The questions the task *list* answers about itself, kept out of the editor because both of the
 * original two were inferences and both were wrong.
 *
 * The list has four ways to hide a task and they overlap: `only done` keeps what finished
 * successfully, `only running` keeps what is moving right now, `only failed` keeps what stopped
 * and wants a person, and Clear finished takes what finished out. Clear's set is a superset of
 * `only done`'s, so an empty list has to be explained by asking about Clear first — otherwise a
 * list emptied by Clear blames the filter and tells the author nothing has finished at the exact
 * moment ten things have.
 */
import type { Task } from '../../src/shared/ipc';

/** What the four controls are set to. Held by the pane; nothing here reads the pane. */
export interface ListFilter {
  /** Hashes taken out of the *list* by Clear finished. Nothing is deleted from `tasks.jsonl`. */
  cleared: ReadonlySet<string>;
  onlyDone: boolean;
  /**
   * Narrow to what is moving. Independent of {@link onlyDone} rather than a third state of one
   * control: `done` and `running` are disjoint, so ticking both is a request for nothing — and
   * that is what it shows, with {@link emptyBecause} naming the pair rather than one of them.
   */
  onlyRunning: boolean;
  /**
   * Narrow to what stopped and wants a person — `failed` **and** `needs_human` both.
   *
   * Two statuses under one tick, deliberately. They are one question for the author asking it
   * ("what went wrong?"), and a shot that exhausted its refinement attempts is the single most
   * likely answer — so a tick named for failure that hid `needs_human` would hide the very thing
   * it was ticked to find.
   */
  onlyFailed: boolean;
}

/** The statuses {@link ListFilter.onlyFailed} keeps. */
function stopped(task: Task): boolean {
  return task.status === 'failed' || task.status === 'needs_human';
}

/** Whether a task survives the status ticks. Any two of them are disjoint, so both on is empty. */
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
  // More than one tick on asks for a task in two states at once, which no task ever is. Say that,
  // rather than blaming whichever one happens to be tested first.
  const on = ticked(filter);
  if (on.length > 1) {
    return `No task is ${on.join(' and ')} at once — untick all but one of the ${on.length}.`;
  }
  if (filter.onlyFailed)
    return 'Nothing has failed or been flagged for a person — untick “only failed” to see the rest.';
  if (filter.onlyRunning) return 'Nothing is running — untick “only running” to see the rest.';
  return 'Nothing here has finished — untick “only done” to see the rest.';
}
