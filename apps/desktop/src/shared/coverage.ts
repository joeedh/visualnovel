/**
 * The pure half of `story.setCoverage`: which lines a shot is on screen for, plus the geometry
 * a drag resolves against.
 *
 * It is in `shared/` for the same reason `branchops.ts` is — the timeline runs these functions
 * mid-drag to draw what a drop would produce, so the preview and the commit are the same rule
 * rather than two copies that can disagree. `spansFor`/`resolveDrag` live here rather than in
 * the renderer because `timeline.cover` (`interactions.ts`) enumerates its targets with them,
 * and main answers `interaction.targets` with that same enumeration.
 *
 * One invariant, and it is the whole point: **no line is covered by two shots.** The exporter
 * picks the first shot covering a line, so a doubly-covered line silently prefers whichever
 * shot happens to be first and the second shot's frame is never seen. Assigning a line to a
 * shot therefore takes it away from whatever held it before.
 *
 * Coverage is a *set*, not a range. The deterministic decomposer interleaves — the establishing
 * shot takes every narration line while each medium shot takes one character's dialogue — so
 * non-contiguous coverage is the normal case, not an edge case: a shot draws as a list of
 * contiguous *segments*, and crossing extents are separated into lanes.
 */
import type { CoverageLine, CoverageShot } from './ipc.js';

/** Just enough of a `Shot` to reason about coverage. */
export interface CoverShot {
  id: string;
  coversLines: string[];
}

export type CoverageOp =
  | {
      ok: true;
      /** Every shot whose coverage changed, with its complete new line set. */
      changed: CoverShot[];
      /** Line ids no shot covers after the edit — a visible state, never an error. */
      uncovered: string[];
      message: string;
    }
  | { ok: false; error: string };

const refuse = (error: string): CoverageOp => ({ ok: false, error });

/**
 * Assign `lines` to `shot`, taking each of them off every other shot.
 *
 * `lineOrder` is the scene's line ids in screenplay order; it both validates the request (a
 * shot may not bind a line the scene does not have — the same rule `decomposeScene` applies to
 * an LLM's answer) and orders the result, so a file's `coversLines` always reads down the page.
 *
 * Lines the shot gives up are simply released. They become gaps, which the timeline draws as
 * uncovered — the one state this editor exists to reveal — rather than being quietly handed to
 * a neighbour the author did not name.
 *
 * Refuses a claim that would leave another shot covering nothing: releasing does not give lines
 * back, so a drag that swept over a neighbour and returned would destroy it. Revealing a shot
 * that covers nothing is this surface's job; manufacturing one is not.
 */
export function setCoverage(
  shots: readonly CoverShot[],
  args: { shot: string; lines: readonly string[]; lineOrder: readonly string[] },
): CoverageOp {
  const target = shots.find((s) => s.id === args.shot);
  if (!target) return refuse(`No shot "${args.shot}" in this scene.`);

  const rank = new Map(args.lineOrder.map((id, i) => [id, i]));
  const unknown = args.lines.filter((id) => !rank.has(id));
  if (unknown.length) {
    return refuse(`Scene has no line ${unknown.map((id) => `"${id}"`).join(', ')}.`);
  }

  const claimed = new Set(args.lines);
  const sorted = [...claimed].sort((a, b) => rank.get(a)! - rank.get(b)!);

  const next = shots.map((shot) =>
    shot.id === target.id
      ? { id: shot.id, coversLines: sorted }
      : { id: shot.id, coversLines: shot.coversLines.filter((id) => !claimed.has(id)) },
  );
  const before = new Map(shots.map((s) => [s.id, s.coversLines]));
  // The dragged shot leads, then the ones it took from in scene order — so a caller reading
  // `changed` sees the act before its consequences.
  const changed = next
    .filter((s) => !sameLines(before.get(s.id)!, s.coversLines))
    .sort((a, b) => Number(b.id === target.id) - Number(a.id === target.id));

  if (!changed.length) return refuse(`${target.id} already covers exactly those lines.`);

  // Emptying a *neighbour* is a deletion in disguise, and a drag sweeps across its neighbours on
  // the way to anywhere. Releasing does not give lines back, so dragging an edge over a shot and
  // returning would leave it real, paid for, and permanently undisplayable. The dragged shot may
  // still empty itself (`resolveDrag` never asks for that); this refuses only the side effect.
  const emptied = changed.filter(
    (s) => s.id !== target.id && s.coversLines.length === 0 && before.get(s.id)!.length > 0,
  );
  if (emptied.length) {
    return refuse(
      `That would leave ${emptied.map((s) => s.id).join(', ')} covering nothing. ` +
        `Move its coverage somewhere else first.`,
    );
  }
  const taken = changed
    .filter((s) => s.id !== target.id)
    .reduce((n, s) => n + before.get(s.id)!.length - s.coversLines.length, 0);

  const covered = new Set(next.flatMap((s) => s.coversLines));
  const uncovered = args.lineOrder.filter((id) => !covered.has(id));
  const from = taken > 0 ? `, taking ${taken} from ${changed.length - 1} other shot(s)` : '';
  return {
    ok: true,
    changed,
    uncovered,
    message: `${target.id} covers ${sorted.length} line(s)${from}.`,
  };
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

// ---------------------------------------------------------------------------
// The geometry: lines × shots → what the strip draws, and what a drag would produce.
// ---------------------------------------------------------------------------

/** One line of script, with whoever is covering it. */
export interface CoverageRow {
  line: CoverageLine;
  index: number;
  /** Ids of the shots covering it — empty is a gap, more than one is an overlap. */
  shots: string[];
}

/** A contiguous run of covered lines: one drawn bracket. */
export interface Segment {
  shotId: string;
  /** Inclusive row indices. */
  from: number;
  to: number;
}

export interface ShotSpan {
  shot: CoverageShot;
  segments: Segment[];
  /** Extent of the whole shot; `-1` when it covers nothing at all. */
  first: number;
  last: number;
  /** Which column the brackets are drawn in. Shots with crossing extents never share one. */
  lane: number;
}

export interface Coverage {
  rows: CoverageRow[];
  /** Shots that cover at least one line, in first-line order. */
  spans: ShotSpan[];
  /** Shots covering nothing: real, addressable, and never displayed by the runner. */
  orphans: CoverageShot[];
  lanes: number;
  /** Row indices no shot covers — the state this editor exists to reveal. */
  gaps: number[];
  /** Row indices more than one shot claims; the exporter would show only the first. */
  overlaps: number[];
}

/** Lines × shots → rows, bracket segments, lanes, gaps and overlaps. */
export function spansFor(lines: readonly CoverageLine[], shots: readonly CoverageShot[]): Coverage {
  const index = new Map(lines.map((l, i) => [l.id, i]));
  const rows: CoverageRow[] = lines.map((line, i) => ({ line, index: i, shots: [] }));

  const spans: ShotSpan[] = [];
  const orphans: CoverageShot[] = [];
  for (const shot of shots) {
    // A line id the scene no longer has is dropped rather than drawn at a made-up position;
    // `readShots` already drops it on load, so this only guards a stale in-flight payload.
    const covered = shot.coversLines
      .map((id) => index.get(id))
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b);
    if (covered.length === 0) {
      orphans.push(shot);
      continue;
    }
    for (const i of covered) rows[i]!.shots.push(shot.id);
    spans.push({
      shot,
      segments: runsOf(shot.id, covered),
      first: covered[0]!,
      last: covered[covered.length - 1]!,
      lane: 0,
    });
  }

  spans.sort((a, b) => a.first - b.first || a.last - b.last);
  const lanes = assignLanes(spans);

  return {
    rows,
    spans,
    orphans,
    lanes,
    gaps: rows.filter((r) => r.shots.length === 0).map((r) => r.index),
    overlaps: rows.filter((r) => r.shots.length > 1).map((r) => r.index),
  };
}

/** Sorted indices → contiguous runs. Exported for the renderer's ghost brackets. */
export function runsOf(shotId: string, covered: readonly number[]): Segment[] {
  const segments: Segment[] = [];
  for (const i of covered) {
    const open = segments[segments.length - 1];
    if (open && open.to === i - 1) open.to = i;
    else segments.push({ shotId, from: i, to: i });
  }
  return segments;
}

/**
 * Greedy first-fit over extents, not segments: a shot occupies its whole `first…last` column
 * even across its holes, so a second shot never draws inside the first one's bracket.
 */
function assignLanes(spans: ShotSpan[]): number {
  const busyUntil: number[] = [];
  for (const span of spans) {
    let lane = busyUntil.findIndex((end) => end < span.first);
    if (lane < 0) lane = busyUntil.length;
    busyUntil[lane] = span.last;
    span.lane = lane;
  }
  return busyUntil.length;
}

export type Edge = 'start' | 'end';

/**
 * Which lines the dragged shot asks for once its `edge` is dropped on row `target`.
 *
 * Extending claims every line in the new region; retracting releases every line beyond the
 * new boundary. Lines the shot did **not** cover inside its own extent are left alone in both
 * directions — those holes belong to the shots that interleave with it, and a drag of one edge
 * is not a statement about them.
 *
 * Returns `null` when the drop changes nothing.
 */
export function resolveDrag(
  coverage: Coverage,
  shotId: string,
  edge: Edge,
  target: number,
): string[] | null {
  const span = coverage.spans.find((s) => s.shot.id === shotId);
  if (!span) return null;
  const clamped = Math.max(0, Math.min(coverage.rows.length - 1, target));

  const covered = new Set(span.segments.flatMap((s) => range(s.from, s.to)));
  if (edge === 'start') {
    if (clamped === span.first) return null;
    if (clamped < span.first) for (const i of range(clamped, span.first)) covered.add(i);
    // Retracting past the last covered line would empty the shot; keep that line.
    else for (const i of range(span.first, Math.min(clamped, span.last) - 1)) covered.delete(i);
  } else {
    if (clamped === span.last) return null;
    if (clamped > span.last) for (const i of range(span.last, clamped)) covered.add(i);
    else for (const i of range(Math.max(clamped, span.first) + 1, span.last)) covered.delete(i);
  }

  const lines = [...covered].sort((a, b) => a - b).map((i) => coverage.rows[i]!.line.id);
  return sameLines(lines, span.shot.coversLines) ? null : lines;
}

export const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
