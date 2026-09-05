/**
 * The timeline's ghost geometry, which is how a proposed drag is drawn over the committed strip.
 *
 * `spansFor`, `resolveDrag` and `runsOf` moved out of this module to `@vn/scriptedit`
 * (`coverage.ts`) beside the rule they feed, because both hosts (this app and the authoring agent)
 * enumerate targets and settle drags with the same geometry. Only the drawing stays here, since
 * main has no use for a ghost.
 */
import { range, runsOf, type Segment } from '@vn/scriptedit';
import type { Coverage, ShotSpan } from '../../../src/shared/ipc.js';
import { TOP } from '../../../src/shared/interactions.js';

/**
 * The shot a reorder drop at `row` would sit after, named the way `timeline.reorder` names its
 * targets. Answers {@link TOP} above the first shot's midpoint. Otherwise answers the last shot
 * whose own midpoint is at or above the row.
 *
 * The test is on midpoints rather than on the boundaries between brackets, for the reason
 * `dropTarget` gives in the script column: the gap between two brackets is a hairline, and an
 * insertion point the author can only hit by accident is not one they can aim at. `spans` is in
 * first-line order, so a single pass settles it.
 */
export function shotDropTarget(spans: readonly ShotSpan[], row: number): string {
  let target = TOP;
  for (const span of spans) {
    if (row >= (span.first + span.last) / 2) target = span.shot.id;
  }
  return target;
}

/**
 * The row a drop after `target` would insert at, which is the row the marker is drawn above. A drop
 * past the last line gives `rows.length`. {@link TOP} is row 0, since that is what an empty `after`
 * means.
 */
export function insertionRow(spans: readonly ShotSpan[], target: string, rows: number): number {
  if (target === TOP) return 0;
  const span = spans.find((s) => s.shot.id === target);
  return span ? Math.min(span.last + 1, rows) : rows;
}

/** What a drag would produce, drawn over the committed strip rather than applied to it. */
export interface DragPreview {
  shotId: string;
  /** The lane the shot already occupies. A preview never re-lanes — see `previewOf`. */
  lane: number;
  /** Contiguous runs of the proposed line set: the ghost brackets. */
  segments: Segment[];
  /** Rows the shot does not cover yet and would. */
  claimed: number[];
  /** Rows it would give up. Each becomes a gap unless another shot already covers it too. */
  released: number[];
}

/**
 * The ghost geometry for an in-flight drag, resolved against committed coverage.
 *
 * Deliberately not `spansFor` over mutated shots: lanes are greedy first-fit over extents, so
 * re-deriving them per pointer move moves shots the author never touched into other columns and
 * changes the column count under the cursor. The dragged shot keeps `span.lane` and every other
 * bracket keeps its geometry; only this overlay moves. That also keeps the grabbed handle under
 * the pointer, since the bracket it belongs to no longer slides out from beneath it.
 *
 * Returns `null` for a shot that draws no bracket, because it has no lane to draw a ghost in.
 */
export function previewOf(
  coverage: Coverage,
  shotId: string,
  lines: readonly string[],
): DragPreview | null {
  const span = coverage.spans.find((s) => s.shot.id === shotId);
  if (!span) return null;

  const index = new Map(coverage.rows.map((r) => [r.line.id, r.index]));
  const next = [
    ...new Set(lines.map((id) => index.get(id)).filter((i): i is number => i !== undefined)),
  ].sort((a, b) => a - b);
  if (next.length === 0) return null;

  const now = new Set(span.segments.flatMap((s) => range(s.from, s.to)));
  const proposed = new Set(next);
  return {
    shotId,
    lane    : span.lane,
    segments: runsOf(shotId, next),
    claimed : next.filter((i) => !now.has(i)),
    released: [...now].filter((i) => !proposed.has(i)).sort((a, b) => a - b),
  };
}
