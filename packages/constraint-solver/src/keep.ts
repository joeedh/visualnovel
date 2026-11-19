/**
 * The keep set: the slots whose art a collection keeps, which a family lists more widely than the
 * slots it enumerates, with each kept slot's identity and every take that identity's task drew.
 * Which rows and files that keeps is the collector's own business, since it reads the disk.
 */
import { taskHash } from '@vn/taskgraph';
import type { Family, SolverFacts } from './family.js';

/** What a collection keeps, by slot. */
export interface KeepSet {
  /** The address of every kept slot. */
  slots: Set<string>;
  /** The task hash of every kept slot whose kind states an identity. */
  tasks: Set<string>;
  /** Every output the log records for those tasks, final or of an attempt. */
  outputs: Set<string>;
}

/** Answers the keep set over the slots the family's `kept` lists. */
export function keepSet<F extends SolverFacts>(family: Family<F>, facts: F): KeepSet {
  const slots = new Set<string>();
  const tasks = new Set<string>();
  for (const { kind, binding } of family.kept(facts)) {
    const key = kind.key(binding);
    if (slots.has(key)) continue;
    slots.add(key);
    const decided = kind.resolve(binding, facts);
    if (decided.ok) tasks.add(taskHash(kind.task, decided.plan));
  }

  const outputs = new Set<string>();
  for (const hash of tasks) {
    const task = facts.tasks.get(hash);
    if (task?.output) outputs.add(task.output);
    for (const attempt of task?.attempts ?? []) if (attempt.output) outputs.add(attempt.output);
  }
  return { slots, tasks, outputs };
}
