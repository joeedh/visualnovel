/**
 * The strip while a command is in flight. Every write re-reads the whole strip when it lands, so a
 * gesture, a retype or a wardrobe pick started mid-write would be judged against rows the landing
 * is about to replace — the surface locks instead, and {@link WRITE_PENDING} is both the refusal a
 * blocked grab is told and the tooltip every locked control carries.
 *
 * The bar itself waits {@link BUSY_DELAY_MS} before appearing: most commands land faster than a
 * progress bar can be read, and a flash on every retyped line would make the strip feel slower
 * than it is. The lock is immediate; only the *telling* is delayed.
 */
import type { Notice } from '../../../src/shared/lineedit.js';

/** How long a write runs before the notice row becomes a progress bar. */
export const BUSY_DELAY_MS = 150;

/** The one sentence a locked surface has to say, wherever the author tries it. */
export const WRITE_PENDING: Notice = {
  tone: 'refused',
  text: 'Waiting for the last edit to land.',
};

/**
 * What the strip knows about the write in flight. `title` is the command's own name — the bar
 * reads "Moving shot…", not a generic spinner — and `shown` is whether the delay has elapsed.
 */
export type Busy = { pending: false } | { pending: true; title: string; shown: boolean };

export const SETTLED: Busy = { pending: false };

/** A command was sent. The surface locks now; the bar appears only if the write outlives the delay. */
export function beginWrite(title: string): Busy {
  return { pending: true, title, shown: false };
}

/** The delay elapsed. Only a still-pending write becomes visible — a settled one stays settled. */
export function revealBusy(busy: Busy): Busy {
  return busy.pending ? { ...busy, shown: true } : busy;
}

/** What the progress bar says, or `null` while there is nothing to show — pending but not yet due. */
export function busyLabel(busy: Busy): string | null {
  return busy.pending && busy.shown ? `${busy.title}…` : null;
}
