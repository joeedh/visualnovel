import { resolveDrag, spansFor } from '../coverage.js';
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
