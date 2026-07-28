import { previewOf } from '../coverage.js';
import { resolveDrag, spansFor } from '../../../../../src/shared/coverage.js';
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
