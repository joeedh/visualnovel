/**
 * The timeline's ghost geometry: how a proposed drag is drawn *over* the committed strip.
 *
 * Everything else this module used to hold — `spansFor`, `resolveDrag`, `runsOf` — moved to
 * `src/shared/coverage.ts` beside the rule they feed, because `timeline.cover` enumerates its
 * targets with them and main answers `interaction.targets` with that same enumeration. What
 * stays here is drawing: main has no use for a ghost.
 */
import { runsOf, range, type Coverage, type Segment } from '../../../../src/shared/coverage.js';

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
 * The ghost geometry for an in-flight drag, resolved against **committed** coverage.
 *
 * Deliberately not `spansFor` over mutated shots: lanes are greedy first-fit over *extents*, so
 * re-deriving them per pointer move moves shots the author never touched into other columns and
 * changes the column count under the cursor. The dragged shot keeps `span.lane` and every other
 * bracket keeps its geometry; only this overlay moves. It also keeps the grabbed handle under
 * the pointer, since the bracket it belongs to no longer slides out from beneath it.
 *
 * Returns `null` for a shot that draws no bracket — it has no lane to draw a ghost in.
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
    lane: span.lane,
    segments: runsOf(shotId, next),
    claimed: next.filter((i) => !now.has(i)),
    released: [...now].filter((i) => !proposed.has(i)).sort((a, b) => a - b),
  };
}
