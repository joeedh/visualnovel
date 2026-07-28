import { resolveDrag, setCoverage, spansFor, type CoverShot } from '../coverage.js';
import type { CoverageLine, CoverageShot } from '../ipc.js';

const LINES = ['s:L1', 's:L2', 's:L3', 's:L4', 's:L5', 's:L6'];

/**
 * The deterministic decomposer's own shape: interleaved, non-contiguous coverage. Every shot
 * holds **two** lines, because a one-line shot is emptied by any claim that touches it and the
 * empty-a-neighbour refusal would then be the only thing these cases could exercise.
 */
const shots = (): CoverShot[] => [
  { id: 's__establishing', coversLines: ['s:L1', 's:L4'] },
  { id: 's__beat1', coversLines: ['s:L2', 's:L5'] },
  { id: 's__beat2', coversLines: ['s:L3', 's:L6'] },
];

describe('setCoverage', () => {
  it('takes a claimed line off whatever shot held it', () => {
    const op = setCoverage(shots(), {
      shot: 's__beat1',
      lines: ['s:L2', 's:L4', 's:L5'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed).toEqual([
      { id: 's__beat1', coversLines: ['s:L2', 's:L4', 's:L5'] },
      { id: 's__establishing', coversLines: ['s:L1'] },
    ]);
    expect(op.uncovered).toEqual([]);
  });

  it('orders the new set by the screenplay, not by the request', () => {
    const op = setCoverage(shots(), {
      shot: 's__beat1',
      lines: ['s:L5', 's:L2', 's:L1'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]!.coversLines).toEqual(['s:L1', 's:L2', 's:L5']);
  });

  it('never leaves a line in two shots, however the claim overlaps', () => {
    const op = setCoverage(shots(), {
      shot: 's__beat2',
      lines: ['s:L1', 's:L2', 's:L3', 's:L6'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    const byId = new Map(op.changed.map((s) => [s.id, s.coversLines]));
    expect(byId.get('s__beat2')).toEqual(['s:L1', 's:L2', 's:L3', 's:L6']);
    expect(byId.get('s__establishing')).toEqual(['s:L4']);
    expect(byId.get('s__beat1')).toEqual(['s:L5']);
  });

  /**
   * The corruption this rule exists for, straight off `commands.jsonl`: an author dragged
   * `arrival__establishing`'s start over `arrival__beat1` and back, which claimed `beat1`'s only
   * line and then released it to nobody. `beat1` was left real, paid for, and covering nothing,
   * and the return trip could not undo it — releasing does not give lines back.
   */
  it('refuses a claim that would leave another shot covering nothing', () => {
    const op = setCoverage(shots(), {
      shot: 's__establishing',
      lines: ['s:L1', 's:L2', 's:L4', 's:L5'],
      lineOrder: LINES,
    });
    expect(op).toMatchObject({ ok: false, error: expect.stringContaining('s__beat1') });
  });

  it('still lets a shot give up every line of its own', () => {
    // Only the side effect is refused. `resolveDrag` never asks for this, so it is reachable
    // from the command DSL alone — an addressable act, not something a gesture does in passing.
    const op = setCoverage(shots(), { shot: 's__beat1', lines: [], lineOrder: LINES });
    expect(op.ok).toBe(true);
  });

  it('does not refuse over a shot that already covered nothing', () => {
    const withOrphan = [...shots(), { id: 's__orphan', coversLines: [] }];
    const op = setCoverage(withOrphan, {
      shot: 's__establishing',
      lines: ['s:L1', 's:L4', 's:L6'],
      lineOrder: LINES,
    });
    expect(op.ok).toBe(true);
  });

  it('reports released lines as uncovered rather than reassigning them', () => {
    const op = setCoverage(shots(), { shot: 's__establishing', lines: ['s:L4'], lineOrder: LINES });
    if (!op.ok) throw new Error(op.error);
    // L1 belonged to no one else, so it is now a gap — the editor's alarming state.
    expect(op.uncovered).toEqual(['s:L1']);
    expect(op.changed).toEqual([{ id: 's__establishing', coversLines: ['s:L4'] }]);
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
      lines: ['s:L2', 's:L5'],
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

// ---------------------------------------------------------------------------
// The geometry. Its own fixture: four lines, and the decomposer's interleaving.
// ---------------------------------------------------------------------------

const SCRIPT: CoverageLine[] = [
  { id: 's:L1', kind: 'narration', text: 'The roof, at dusk.' },
  { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 's:L3', kind: 'dialogue', speaker: 'ren', text: 'You came.' },
  { id: 's:L4', kind: 'narration', text: 'She bows, a little too deeply.' },
];

const drawn = (id: string, coversLines: string[]): CoverageShot => ({
  id,
  framing: 'medium',
  subjects: [],
  coversLines,
  status: 'accepted',
});

const SHOTS: CoverageShot[] = [
  drawn('s__establishing', ['s:L1', 's:L4']),
  drawn('s__aiko', ['s:L2']),
  drawn('s__ren', ['s:L3']),
];

describe('spansFor', () => {
  it('splits non-contiguous coverage into separate brackets', () => {
    const cov = spansFor(SCRIPT, SHOTS);
    const est = cov.spans.find((s) => s.shot.id === 's__establishing')!;
    expect(est.segments).toEqual([
      { shotId: 's__establishing', from: 0, to: 0 },
      { shotId: 's__establishing', from: 3, to: 3 },
    ]);
    expect([est.first, est.last]).toEqual([0, 3]);
  });

  it('lanes shots by extent, so an interleaved bracket never draws inside another', () => {
    const cov = spansFor(SCRIPT, SHOTS);
    const lane = new Map(cov.spans.map((s) => [s.shot.id, s.lane]));
    // The establishing shot spans the whole scene, so the two mediums it straddles move over.
    expect(lane.get('s__establishing')).toBe(0);
    expect(lane.get('s__aiko')).toBe(1);
    expect(lane.get('s__ren')).toBe(1);
    expect(cov.lanes).toBe(2);
  });

  it('reports gaps and overlaps by row', () => {
    const cov = spansFor(SCRIPT, [drawn('s__a', ['s:L1', 's:L2']), drawn('s__b', ['s:L2'])]);
    expect(cov.overlaps).toEqual([1]);
    expect(cov.gaps).toEqual([2, 3]);
    expect(cov.rows[1]!.shots).toEqual(['s__a', 's__b']);
  });

  it('separates a shot that covers nothing from the drawn spans', () => {
    const cov = spansFor(SCRIPT, [drawn('s__ghost', []), drawn('s__gone', ['s:L9'])]);
    expect(cov.spans).toEqual([]);
    expect(cov.orphans.map((s) => s.id)).toEqual(['s__ghost', 's__gone']);
    expect(cov.gaps).toEqual([0, 1, 2, 3]);
  });
});

describe('resolveDrag', () => {
  const cov = spansFor(SCRIPT, SHOTS);

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
