import { previewOf, resolveDrag, spansFor } from '../coverage.js';
import type { CoverageLine, CoverageShot } from '../../../../../src/shared/ipc';

const LINES: CoverageLine[] = [
  { id: 's:L1', kind: 'action', text: 'The roof, at dusk.' },
  { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 's:L3', kind: 'dialogue', speaker: 'ren', text: 'You came.' },
  { id: 's:L4', kind: 'narration', text: 'She bows, a little too deeply.' },
];

const shot = (id: string, coversLines: string[]): CoverageShot => ({
  id,
  framing: 'medium',
  subjects: [],
  coversLines,
  status: 'accepted',
});

/** `deterministicShots`' own shape: the plate takes the narration, each medium one speaker. */
const SHOTS: CoverageShot[] = [
  shot('s__establishing', ['s:L1', 's:L4']),
  shot('s__aiko', ['s:L2']),
  shot('s__ren', ['s:L3']),
];

describe('spansFor', () => {
  it('splits non-contiguous coverage into separate brackets', () => {
    const cov = spansFor(LINES, SHOTS);
    const est = cov.spans.find((s) => s.shot.id === 's__establishing')!;
    expect(est.segments).toEqual([
      { shotId: 's__establishing', from: 0, to: 0 },
      { shotId: 's__establishing', from: 3, to: 3 },
    ]);
    expect([est.first, est.last]).toEqual([0, 3]);
  });

  it('lanes shots by extent, so an interleaved bracket never draws inside another', () => {
    const cov = spansFor(LINES, SHOTS);
    const lane = new Map(cov.spans.map((s) => [s.shot.id, s.lane]));
    // The establishing shot spans the whole scene, so the two mediums it straddles move over.
    expect(lane.get('s__establishing')).toBe(0);
    expect(lane.get('s__aiko')).toBe(1);
    expect(lane.get('s__ren')).toBe(1);
    expect(cov.lanes).toBe(2);
  });

  it('reports gaps and overlaps by row', () => {
    const cov = spansFor(LINES, [shot('s__a', ['s:L1', 's:L2']), shot('s__b', ['s:L2'])]);
    expect(cov.overlaps).toEqual([1]);
    expect(cov.gaps).toEqual([2, 3]);
    expect(cov.rows[1]!.shots).toEqual(['s__a', 's__b']);
  });

  it('separates a shot that covers nothing from the drawn spans', () => {
    const cov = spansFor(LINES, [shot('s__ghost', []), shot('s__gone', ['s:L9'])]);
    expect(cov.spans).toEqual([]);
    expect(cov.orphans.map((s) => s.id)).toEqual(['s__ghost', 's__gone']);
    expect(cov.gaps).toEqual([0, 1, 2, 3]);
  });
});

describe('resolveDrag', () => {
  const cov = spansFor(LINES, SHOTS);

  it('claims every line in the region an extended edge sweeps', () => {
    expect(resolveDrag(cov, 's__aiko', 'end', 3)).toEqual(['s:L2', 's:L3', 's:L4']);
    expect(resolveDrag(cov, 's__ren', 'start', 0)).toEqual(['s:L1', 's:L2', 's:L3']);
  });

  it('releases lines beyond a retracted edge, leaving interior holes alone', () => {
    // The establishing shot covers L1 and L4; pulling its end back to L3 drops only L4.
    expect(resolveDrag(cov, 's__establishing', 'end', 2)).toEqual(['s:L1']);
    expect(resolveDrag(cov, 's__establishing', 'start', 1)).toEqual(['s:L4']);
  });

  it('never empties a shot by retracting past its far edge', () => {
    expect(resolveDrag(cov, 's__establishing', 'start', 3)).toEqual(['s:L4']);
    expect(resolveDrag(cov, 's__establishing', 'end', 0)).toEqual(['s:L1']);
  });

  it('clamps a drop outside the script, and reports an unchanged drop as null', () => {
    expect(resolveDrag(cov, 's__aiko', 'start', -5)).toEqual(['s:L1', 's:L2']);
    expect(resolveDrag(cov, 's__aiko', 'end', 1)).toBeNull();
    expect(resolveDrag(cov, 's__nope', 'end', 3)).toBeNull();
  });
});

describe('previewOf', () => {
  const cov = spansFor(LINES, SHOTS);

  /**
   * The regression this function exists for. Deriving the preview with `spansFor` over mutated
   * shots re-runs the greedy lane fit: growing `s__aiko` to the end of the scene gives it the
   * widest extent, which moves `s__establishing` — a shot the author never touched — into
   * another column and changes the grid's column count mid-gesture.
   */
  it('keeps the dragged shot in its own lane no matter how far the drag reaches', () => {
    const lines = resolveDrag(cov, 's__aiko', 'end', 3)!;
    expect(previewOf(cov, 's__aiko', lines)!.lane).toBe(1);

    const relaned = spansFor(
      LINES,
      SHOTS.map((s) =>
        s.id === 's__aiko'
          ? { ...s, coversLines: lines }
          : { ...s, coversLines: s.coversLines.filter((id) => !lines.includes(id)) },
      ),
    );
    expect(relaned.spans.find((s) => s.shot.id === 's__aiko')!.lane).toBe(0);
  });

  it('brackets the proposal as contiguous runs, holes and all', () => {
    // The establishing shot covers L1 and L4; extending its start is a no-op, so extend the end.
    const lines = resolveDrag(cov, 's__aiko', 'start', 0)!;
    expect(previewOf(cov, 's__aiko', lines)!.segments).toEqual([
      { shotId: 's__aiko', from: 0, to: 1 },
    ]);
    expect(previewOf(cov, 's__establishing', ['s:L1', 's:L3', 's:L4'])!.segments).toEqual([
      { shotId: 's__establishing', from: 0, to: 0 },
      { shotId: 's__establishing', from: 2, to: 3 },
    ]);
  });

  it('reports the rows changing hands, in row order', () => {
    const grow = previewOf(cov, 's__aiko', ['s:L1', 's:L2', 's:L3'])!;
    expect(grow.claimed).toEqual([0, 2]);
    expect(grow.released).toEqual([]);

    const shrink = previewOf(cov, 's__establishing', ['s:L1'])!;
    expect(shrink.claimed).toEqual([]);
    expect(shrink.released).toEqual([3]);
  });

  it('has nothing to draw for a shot with no bracket, or a proposal of no real lines', () => {
    expect(previewOf(cov, 's__nope', ['s:L1'])).toBeNull();
    expect(previewOf(cov, 's__aiko', ['s:L9'])).toBeNull();
    expect(previewOf(cov, 's__aiko', [])).toBeNull();
  });
});
