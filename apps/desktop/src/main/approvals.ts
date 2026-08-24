/**
 * The order the needs-approval list is shown in.
 *
 * `WorkspaceSession.approvable()` answers upstream-first, which is the order approval has to
 * happen in, not the order an author wants to read. The toolbar list shows what turned up most
 * recently first, so it is a diff against the order last shown rather than a property of the
 * project. Kept pure and separate from the session so it can be tested without one.
 */
import type { Approvable } from '@vn/authoring';

/** What `reorderApprovals` answers: the rows to draw, and the order to remember them by. */
export interface ApprovalQueue {
  items: Approvable[];
  order: string[];
}

/**
 * Put `items` in most-recently-surfaced-first order against `previousOrder`.
 *
 * A hash `previousOrder` already knows keeps its place relative to the others it knows. A hash it
 * does not is new since the list was last read, so it goes ahead of all of them, keeping the
 * upstream-first order `approvable()` returned within that batch. A hash `previousOrder` holds
 * that is no longer waiting (approved, or its slot is gone) is dropped.
 */
export function reorderApprovals(
  items: readonly Approvable[],
  previousOrder: readonly string[],
): ApprovalQueue {
  const byHash = new Map(items.map((item) => [item.hash, item]));
  const known = new Set(previousOrder);
  const fresh = items.filter((item) => !known.has(item.hash));
  const kept = previousOrder
    .map((hash) => byHash.get(hash))
    .filter((item): item is Approvable => item !== undefined);
  const ordered = [...fresh, ...kept];
  return { items: ordered, order: ordered.map((item) => item.hash) };
}

/** Whether two queues hold the same hashes, whatever order they are in. */
export function sameApprovals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((hash) => set.has(hash));
}
