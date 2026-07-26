/**
 * The timeline's geometry: a scene's lines and shots → what the strip draws, and what a drag
 * would produce.
 *
 * `coversLines` is a **set**, not a range. The deterministic decomposer interleaves — the
 * establishing shot takes every narration line while each medium shot takes one character's
 * dialogue — so a shot's coverage is routinely non-contiguous, and two shots' extents routinely
 * cross. This module therefore never assumes a range: a shot becomes a list of contiguous
 * *segments*, and crossing extents are separated into lanes so their brackets can't collide.
 *
 * The mutation rule lives in `src/shared/coverage.ts` and is applied by the command; what is
 * here is view math plus `resolveDrag`, which only decides which lines the dragged shot ends up
 * asking for.
 */
import type { CoverageLine, CoverageShot } from '../../../../src/shared/ipc';

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

/** Sorted indices → contiguous runs. */
function runsOf(shotId: string, covered: readonly number[]): Segment[] {
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
  return sameIds(lines, span.shot.coversLines) ? null : lines;
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);
