/**
 * The questions the task *list* answers about itself, kept out of the editor because both of the
 * original two were inferences and both were wrong.
 *
 * The list has three ways to hide a task and they overlap: `only done` keeps what finished
 * successfully, `only running` keeps what is moving right now, and Clear finished takes what
 * finished out. Clear's set is a superset of `only done`'s, so an empty list has to be explained
 * by asking about Clear first — otherwise a list emptied by Clear blames the filter and tells the
 * author nothing has finished at the exact moment ten things have.
 */
import type { Task } from '../../src/shared/ipc';

/** What the three controls are set to. Held by the pane; nothing here reads the pane. */
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
}

/** Whether a task survives the two status ticks. Both on is disjoint, and answers `false`. */
function passesStatus(task: Task, filter: ListFilter): boolean {
  if (filter.onlyDone && task.status !== 'done') return false;
  if (filter.onlyRunning && task.status !== 'running') return false;
  return true;
}

/** The tasks the list is showing: the filter's answer, minus whatever Clear took out of it. */
export function showing(tasks: readonly Task[], filter: ListFilter): Task[] {
  return tasks.filter((task) => !filter.cleared.has(task.hash) && passesStatus(task, filter));
}

/**
 * Why the list is empty, said in terms of the control that emptied it — so the sentence names
 * something the author can act on rather than the first guess that fits.
 */
export function emptyBecause(tasks: readonly Task[], filter: ListFilter): string {
  if (tasks.length === 0) return 'No tasks yet — run the pipeline.';
  if (!tasks.some((task) => !filter.cleared.has(task.hash)))
    return 'Everything is cleared out of this list. Refresh brings it back.';
  // Both ticks on asks for a task that is finished and still moving, which no task ever is. Say
  // that, rather than blaming whichever one happens to be tested first.
  if (filter.onlyDone && filter.onlyRunning)
    return 'Nothing is both done and running — untick one of the two.';
  if (filter.onlyRunning) return 'Nothing is running — untick “only running” to see the rest.';
  return 'Nothing here has finished — untick “only done” to see the rest.';
}
