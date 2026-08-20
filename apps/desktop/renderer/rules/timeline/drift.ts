/**
 * How the strip says a frame no longer illustrates the words beside it. Main derives the drift
 * itself (`@vn/pipeline`'s `driftOf`, surfaced on `CoverageShot.drift`); this module holds only the
 * wording, kept pure so it can be tested and so the task list can reuse the same sentences later.
 */
import type { Drift } from '@vn/types';
import type { CoverageShot } from '../../../src/shared/ipc.js';

/** The bracket's mark for a shot whose prose is not settled. `null` when there is nothing to say. */
export interface DriftTag {
  /** Class suffix on the bracket, so the prominence of the mark stays in the stylesheet. */
  state: 'drifted' | 'unknown';
  /** The short mono label in the bracket head. */
  label: string;
  /** The full sentence shown on hover, including what the next run will and will not do. */
  title: string;
}

export function driftTag(drift: Drift): DriftTag | null {
  switch (drift) {
    case 'drifted':
      return {
        state: 'drifted',
        label: 'OLD PROSE',
        title:
          'The lines this frame covers have been retyped since it was rendered. Nothing rehashed, so nothing re-renders on its own — regenerate it when the difference matters.',
      };
    case 'unknown':
      // Every shot rendered before the hash existed lands here, so the mark stays quiet: the
      // author cannot act on it, and the next render clears it
      return {
        state: 'unknown',
        label: 'PROSE?',
        title:
          'Rendered before the prose was recorded, so whether it still matches cannot be answered. The next render records it.',
      };
    default:
      return null;
  }
}

/**
 * Count of drifted shots, for the bar. `unknown` is deliberately left out: it is a fact about the
 * record rather than about the art, and counting it would read as a count of faults.
 */
export function staleCount(shots: readonly CoverageShot[]): number {
  return shots.filter((s) => s.drift === 'drifted').length;
}
