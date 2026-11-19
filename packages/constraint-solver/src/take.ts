/**
 * The take: which manifest row a slot holds, the order its rows are listed in, what the task log
 * says the take is, and which row stays current when a slot holds more than one.
 *
 * A row carries two bits. `current` says the slot holds it, and `accepted` says a person approved
 * it. Every rule here reads `current` and none reads `accepted`, which is approval's business.
 */
import type { AnyTask, Asset } from '@vn/types';
import { taskHash } from '@vn/taskgraph';
import type { Family, SlotKind, SolverFacts } from './family.js';

/**
 * Answers the row a slot holds out of the rows bound to it, or `undefined` when the answer is not
 * certain. The one current row wins outright; two current rows are a manifest in need of repair,
 * and the slot declines. With none current, the slot answers only when exactly one row serves it.
 * Every caller reads `undefined` as "no claim", never as "the slot is empty".
 */
export function pick(rows: readonly Asset[]): string | undefined {
  const current = rows.filter((a) => a.current);
  if (current.length === 1) return current[0]!.hash;
  if (current.length > 1) return undefined;
  return rows.length === 1 ? rows[0]!.hash : undefined;
}

/**
 * Sorts a slot's rows newest first by the row's `at`, most recently held first. Rows never stamped
 * go last in hash order, so the list is stable and makes no recency claim for them.
 */
export function newestFirst(rows: readonly Asset[]): Asset[] {
  return [...rows].sort((a, b) => {
    if (a.at !== undefined && b.at !== undefined) return b.at.localeCompare(a.at);
    if (a.at !== undefined) return -1;
    if (b.at !== undefined) return 1;
    return a.hash.localeCompare(b.hash);
  });
}

/**
 * Answers the take the task log says a slot's identity drew, or `undefined` where the row is
 * authoritative: a `done` task's output, a `needs_human` task's output or else its last attempt's.
 */
export function loggedTake(task: AnyTask | undefined): string | undefined {
  if (!task) return undefined;
  if (task.status === 'done') return task.output;
  if (task.status === 'needs_human') return task.output ?? task.attempts.at(-1)?.output;
  return undefined;
}

/** Answers, per task hash, the latest `at` stamp among the task's attempts. */
export function lastRenderedAt(tasks: {
  get(hash: string): { attempts: { at?: string }[] } | undefined;
}): (sourceTask: string) => string | undefined {
  return (sourceTask) => {
    const task = tasks.get(sourceTask);
    if (!task) return undefined;
    let latest: string | undefined;
    for (const attempt of task.attempts) {
      if (attempt.at !== undefined && (latest === undefined || attempt.at > latest)) {
        latest = attempt.at;
      }
    }
    return latest;
  };
}

/** One slot holding more than one current row: the row kept current and the rows that lose it. */
export interface OverHeld {
  slot: string;
  keep: string;
  drop: string[];
}

/** Answers the logged take of the identity a slot's kind states over `facts`, if it states one. */
function identityTake<F extends SolverFacts>(
  kind: SlotKind<F>,
  binding: unknown,
  facts: F,
): string | undefined {
  const decided = kind.resolve(binding, facts);
  return decided.ok ? loggedTake(facts.tasks.get(taskHash(kind.task, decided.plan))) : undefined;
}

/**
 * Lists every slot that a current row in the manifest fills and that holds more than one current
 * row, in manifest order, with the row to keep. The keep rule has four arms, in order: a row the
 * kind's `named` lists; the logged take of the slot's identity, resolved over `identity`; the row
 * most recently held or else drawn; the lowest hash. A slot no enumeration lists is repaired too.
 */
export function overHeld<F extends SolverFacts>(
  family: Family<F>,
  facts: F,
  identity: F = facts,
): OverHeld[] {
  const renderedAt = lastRenderedAt(facts.tasks);
  const stamp = (row: Asset): string => row.at ?? renderedAt(row.sourceTask) ?? '';
  const seen = new Set<string>();
  const out: OverHeld[] = [];

  for (const row of facts.assets ?? []) {
    if (!row.current) continue;
    const filled = family.slotOf(row, facts);
    if (!filled) continue;
    const { kind, binding } = filled;
    const key = kind.key(binding);
    if (seen.has(key)) continue;
    seen.add(key);

    const current = kind.candidates(binding, facts).filter((a) => a.current);
    if (current.length < 2) continue;
    const named = kind.named?.(binding, facts);
    const output = identityTake(kind, binding, identity);
    const keep =
      (named ? current.find((a) => named.has(a.hash)) : undefined) ??
      current.find((a) => a.hash === output) ??
      [...current].sort(
        (a, b) => stamp(b).localeCompare(stamp(a)) || a.hash.localeCompare(b.hash),
      )[0]!;
    out.push({
      slot: key,
      keep: keep.hash,
      drop: current.filter((a) => a.hash !== keep.hash).map((a) => a.hash),
    });
  }
  return out;
}
