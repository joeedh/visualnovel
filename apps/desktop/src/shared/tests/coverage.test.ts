import { setCoverage, type CoverShot } from '../coverage.js';

const LINES = ['s:L1', 's:L2', 's:L3', 's:L4'];

/** The deterministic decomposer's own shape: interleaved, non-contiguous coverage. */
const shots = (): CoverShot[] => [
  { id: 's__establishing', coversLines: ['s:L1', 's:L4'] },
  { id: 's__beat1', coversLines: ['s:L2'] },
  { id: 's__beat2', coversLines: ['s:L3'] },
];

describe('setCoverage', () => {
  it('takes a claimed line off whatever shot held it', () => {
    const op = setCoverage(shots(), {
      shot: 's__beat1',
      lines: ['s:L2', 's:L4'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed).toEqual([
      { id: 's__beat1', coversLines: ['s:L2', 's:L4'] },
      { id: 's__establishing', coversLines: ['s:L1'] },
    ]);
    expect(op.uncovered).toEqual([]);
  });

  it('orders the new set by the screenplay, not by the request', () => {
    const op = setCoverage(shots(), {
      shot: 's__beat1',
      lines: ['s:L4', 's:L2', 's:L1'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]!.coversLines).toEqual(['s:L1', 's:L2', 's:L4']);
  });

  it('never leaves a line in two shots, however the claim overlaps', () => {
    const op = setCoverage(shots(), { shot: 's__beat2', lines: LINES, lineOrder: LINES });
    if (!op.ok) throw new Error(op.error);
    const byId = new Map(op.changed.map((s) => [s.id, s.coversLines]));
    expect(byId.get('s__beat2')).toEqual(LINES);
    expect(byId.get('s__establishing')).toEqual([]);
    expect(byId.get('s__beat1')).toEqual([]);
  });

  it('reports released lines as uncovered rather than reassigning them', () => {
    const op = setCoverage(shots(), { shot: 's__establishing', lines: [], lineOrder: LINES });
    if (!op.ok) throw new Error(op.error);
    // L1 and L4 belonged to no one else, so they are now gaps — the editor's alarming state.
    expect(op.uncovered).toEqual(['s:L1', 's:L4']);
    expect(op.changed).toEqual([{ id: 's__establishing', coversLines: [] }]);
  });

  it('refuses a line the scene does not have', () => {
    const op = setCoverage(shots(), {
      shot: 's__beat1',
      lines: ['s:L2', 's:L9'],
      lineOrder: LINES,
    });
    expect(op).toEqual({ ok: false, error: 'Scene has no line "s:L9".' });
  });

  it('refuses an unknown shot, and a no-op', () => {
    expect(setCoverage(shots(), { shot: 'nope', lines: [], lineOrder: LINES })).toMatchObject({
      ok: false,
    });
    const noop = setCoverage(shots(), {
      shot: 's__beat1',
      lines: ['s:L2'],
      lineOrder: LINES,
    });
    expect(noop).toMatchObject({ ok: false, error: expect.stringContaining('already covers') });
  });

  it('deduplicates a repeated claim', () => {
    const op = setCoverage(shots(), {
      shot: 's__beat1',
      lines: ['s:L2', 's:L3', 's:L3'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]!.coversLines).toEqual(['s:L2', 's:L3']);
  });
});
