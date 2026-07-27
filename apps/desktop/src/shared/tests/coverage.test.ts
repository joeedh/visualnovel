import { setCoverage, type CoverShot } from '../coverage.js';

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
