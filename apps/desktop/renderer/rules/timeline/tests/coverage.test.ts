import { insertionRow, previewOf, shotDropTarget } from '../coverage.js';
import { resolveDrag, spansFor } from '@vn/scriptedit';
import type { CoverageLine, CoverageShot } from '../../../../src/shared/ipc';

const LINES: CoverageLine[] = [
  { id: 's:L1', kind: 'narration', text: 'The roof, at dusk.' },
  { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 's:L3', kind: 'dialogue', speaker: 'ren', text: 'You came.' },
  { id: 's:L4', kind: 'narration', text: 'She bows, a little too deeply.' },
];

const shot = (id: string, coversLines: string[]): CoverageShot => ({
  id,
  framing : 'medium',
  subjects: [],
  location: 'day',
  outfits : {},
  coversLines,
  status: 'accepted',
  drift : 'current',
});

/** `deterministicShots`' own shape: the plate takes the narration, each medium one speaker. */
const SHOTS: CoverageShot[] = [
  shot('s__establishing', ['s:L1', 's:L4']),
  shot('s__aiko', ['s:L2']),
  shot('s__ren', ['s:L3']),
];

/** Only a shot with no holes can be reordered, so the reorder geometry is read off this set. */
const ORDERED: CoverageShot[] = [
  shot('s__a', ['s:L1', 's:L2']),
  shot('s__b', ['s:L3']),
  shot('s__c', ['s:L4']),
];

describe('the reorder geometry', () => {
  const cov = spansFor(LINES, ORDERED);

  it('names the shot a drop is after by midpoint, so every insertion point is aimable', () => {
    // Above the first shot's midpoint no shot names the position, so the answer is the empty
    // `after`, spelled `top`
    expect(shotDropTarget(cov.spans, 0)).toBe('top');
    expect(shotDropTarget(cov.spans, 1)).toBe('s__a');
    expect(shotDropTarget(cov.spans, 2)).toBe('s__b');
    expect(shotDropTarget(cov.spans, 3)).toBe('s__c');
  });

  it('draws the marker above the row the shot would land on, and past the end for the last', () => {
    expect(insertionRow(cov.spans, 'top', cov.rows.length)).toBe(0);
    expect(insertionRow(cov.spans, 's__a', cov.rows.length)).toBe(2);
    expect(insertionRow(cov.spans, 's__b', cov.rows.length)).toBe(3);
    expect(insertionRow(cov.spans, 's__c', cov.rows.length)).toBe(4);
  });

  it('puts an unknown target at the end rather than at the top, which would be a real position', () => {
    expect(insertionRow(cov.spans, 's__gone', cov.rows.length)).toBe(4);
  });

  // A shot that other shots draw inside has no single position (`planShotMove` refuses it), but
  // the pointer still passes over its rows, so the midpoint rule must still answer something
  it('still names a target over interleaved coverage', () => {
    const interleaved = spansFor(LINES, SHOTS);
    expect(shotDropTarget(interleaved.spans, 0)).toBe('top');
    expect(shotDropTarget(interleaved.spans, 3)).toBe('s__ren');
  });
});

describe('previewOf', () => {
  const cov = spansFor(LINES, SHOTS);

  // The regression this function exists for: deriving the preview with `spansFor` over mutated
  // shots re-runs the greedy lane fit, so growing `s__aiko` to the end of the scene gives it the
  // widest extent, moving the untouched `s__establishing` into another column mid-gesture
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
    // Dragging aiko's start up to row 0 takes L1 from the establishing shot, so the proposal is
    // one unbroken run; the second case leaves a hole where L2 stays with aiko
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
