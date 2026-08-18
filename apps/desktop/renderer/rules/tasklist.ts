/**
 * The two questions the task *list* answers about itself, kept out of the editor because both
 * are inferences and both were wrong.
 *
 * The list has two ways to hide a task and they overlap: `only done` keeps what finished
 * successfully, and Clear finished takes what finished out. Clear's set is a superset of the
 * filter's, so an empty list has to be explained by asking about Clear first — otherwise a list
 * emptied by Clear blames the filter and tells the author nothing has finished at the exact
 * moment ten things have.
 */
import type { Task } from '../../src/shared/ipc';

/** What the two controls are set to. Held by the pane; nothing here reads the pane. */
export interface ListFilter {
  /** Hashes taken out of the *list* by Clear finished. Nothing is deleted from `tasks.jsonl`. */
  cleared: ReadonlySet<string>;
  onlyDone: boolean;
}

/** The tasks the list is showing: the filter's answer, minus whatever Clear took out of it. */
export function showing(tasks: readonly Task[], filter: ListFilter): Task[] {
  return tasks.filter(
    (task) => !filter.cleared.has(task.hash) && (!filter.onlyDone || task.status === 'done'),
  );
}

/**
 * Why the list is empty, said in terms of the control that emptied it — so the sentence names
 * something the author can act on rather than the first guess that fits.
 */
export function emptyBecause(tasks: readonly Task[], filter: ListFilter): string {
  if (tasks.length === 0) return 'No tasks yet — run the pipeline.';
  if (!tasks.some((task) => !filter.cleared.has(task.hash)))
    return 'Everything is cleared out of this list. Refresh brings it back.';
  return 'Nothing here has finished — untick “only done” to see the rest.';
}
