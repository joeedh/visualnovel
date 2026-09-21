import {
  applyCoverage,
  letteredPagesNote,
  panelLines,
  resolveDrag,
  setCoverage,
  spansFor,
  type CoverShot,
} from '../coverage.js';

const LINES = ['s:L1', 's:L2', 's:L3', 's:L4', 's:L5', 's:L6'];

/**
 * Interleaved, non-contiguous coverage, matching what the deterministic decomposer produces.
 * Every shot holds two lines, because a one-line shot is emptied by any claim that touches it,
 * which would leave the empty-a-neighbour refusal as the only thing these cases exercise.
 */
const shots = (): CoverShot[] => [
  { id: 's__establishing', coversLines: ['s:L1', 's:L4'] },
  { id: 's__beat1', coversLines: ['s:L2', 's:L5'] },
  { id: 's__beat2', coversLines: ['s:L3', 's:L6'] },
];

describe('setCoverage', () => {
  it('takes a claimed line off whatever shot held it', () => {
    const op = setCoverage(shots(), {
      shot     : 's__beat1',
      lines    : ['s:L2', 's:L4', 's:L5'],
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
      shot     : 's__beat1',
      lines    : ['s:L5', 's:L2', 's:L1'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]!.coversLines).toEqual(['s:L1', 's:L2', 's:L5']);
  });

  it('never leaves a line in two shots, however the claim overlaps', () => {
    const op = setCoverage(shots(), {
      shot     : 's__beat2',
      lines    : ['s:L1', 's:L2', 's:L3', 's:L6'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    const byId = new Map(op.changed.map((s) => [s.id, s.coversLines]));
    expect(byId.get('s__beat2')).toEqual(['s:L1', 's:L2', 's:L3', 's:L6']);
    expect(byId.get('s__establishing')).toEqual(['s:L4']);
    expect(byId.get('s__beat1')).toEqual(['s:L5']);
  });

  /**
   * The corruption this rule prevents, recorded in `commands.jsonl`: an author dragged
   * `arrival__establishing`'s start over `arrival__beat1` and back, claiming `beat1`'s only line
   * and then releasing it to nobody. `beat1` was left paid for and covering nothing, and the
   * return trip could not undo it, because releasing a line does not give it back.
   */
  it('refuses a claim that would leave another shot covering nothing', () => {
    const op = setCoverage(shots(), {
      shot     : 's__establishing',
      lines    : ['s:L1', 's:L2', 's:L4', 's:L5'],
      lineOrder: LINES,
    });
    expect(op).toMatchObject({ ok: false, error: expect.stringContaining('s__beat1') });
  });

  it('still lets a shot give up every line of its own', () => {
    // Only emptying a neighbour is refused. `resolveDrag` never asks for this, so it is
    // reachable from the command DSL alone rather than from a drag gesture
    const op = setCoverage(shots(), { shot: 's__beat1', lines: [], lineOrder: LINES });
    expect(op.ok).toBe(true);
  });

  it('does not refuse over a shot that already covered nothing', () => {
    const withOrphan = [...shots(), { id: 's__orphan', coversLines: [] }];
    const op = setCoverage(withOrphan, {
      shot     : 's__establishing',
      lines    : ['s:L1', 's:L4', 's:L6'],
      lineOrder: LINES,
    });
    expect(op.ok).toBe(true);
  });

  it('reports released lines as uncovered rather than reassigning them', () => {
    const op = setCoverage(shots(), { shot: 's__establishing', lines: ['s:L4'], lineOrder: LINES });
    if (!op.ok) throw new Error(op.error);
    // L1 belonged to no other shot, so it is now a gap
    expect(op.uncovered).toEqual(['s:L1']);
    expect(op.changed).toEqual([{ id: 's__establishing', coversLines: ['s:L4'] }]);
  });

  it('refuses a line the scene does not have', () => {
    const op = setCoverage(shots(), {
      shot     : 's__beat1',
      lines    : ['s:L2', 's:L9'],
      lineOrder: LINES,
    });
    expect(op).toEqual({ ok: false, error: 'Scene has no line "s:L9".' });
  });

  it('refuses an unknown shot, and a no-op', () => {
    expect(setCoverage(shots(), { shot: 'nope', lines: [], lineOrder: LINES })).toMatchObject({
      ok: false,
    });
    const noop = setCoverage(shots(), {
      shot     : 's__beat1',
      lines    : ['s:L2', 's:L5'],
      lineOrder: LINES,
    });
    expect(noop).toMatchObject({ ok: false, error: expect.stringContaining('already covers') });
  });

  it('deduplicates a repeated claim', () => {
    const op = setCoverage(shots(), {
      shot     : 's__beat1',
      lines    : ['s:L2', 's:L3', 's:L3'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]!.coversLines).toEqual(['s:L2', 's:L3']);
  });
});

// ---------------------------------------------------------------------------
// Pages. A page's panels partition its lines, so a coverage take has to say which panel a line
// joins or leaves, and every host applies the answer through `applyCoverage`.
// ---------------------------------------------------------------------------

/** A page over the first three lines, two panels, beside a frame over the rest. */
const board = (): CoverShot[] => [
  {
    id         : 's__page1',
    coversLines: ['s:L1', 's:L2', 's:L3'],
    panels     : [{ coversLines: ['s:L1'] }, { coversLines: ['s:L2', 's:L3'] }],
  },
  { id: 's__beat2', coversLines: ['s:L4', 's:L5', 's:L6'] },
];

describe('setCoverage on a page', () => {
  it('drops a released line from its panel, and only that panel', () => {
    const op = setCoverage(board(), {
      shot     : 's__page1',
      lines    : ['s:L1', 's:L2'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]).toEqual({
      id         : 's__page1',
      coversLines: ['s:L1', 's:L2'],
      panels     : [{ coversLines: ['s:L1'] }, { coversLines: ['s:L2'] }],
    });
  });

  it('puts a newly claimed line in the panel holding the line before it', () => {
    const op = setCoverage(board(), {
      shot     : 's__page1',
      lines    : ['s:L1', 's:L2', 's:L3', 's:L4'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]!.panels).toEqual([
      { coversLines: ['s:L1'] },
      { coversLines: ['s:L2', 's:L3', 's:L4'] },
    ]);
    // The frame it was taken from carries no panels, so its change carries none either
    expect(op.changed[1]).toEqual({ id: 's__beat2', coversLines: ['s:L5', 's:L6'] });
  });

  it('puts a line earlier than every lettered one in the first panel', () => {
    const shots = board();
    shots[0]!.coversLines = ['s:L2', 's:L3'];
    shots[0]!.panels = [{ coversLines: ['s:L2'] }, { coversLines: ['s:L3'] }];
    const op = setCoverage(shots, {
      shot     : 's__page1',
      lines    : ['s:L1', 's:L2', 's:L3'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[0]!.panels).toEqual([
      { coversLines: ['s:L1', 's:L2'] },
      { coversLines: ['s:L3'] },
    ]);
  });

  it('keeps every panel in the page order, so the partition reads down the page', () => {
    const op = setCoverage(board(), {
      shot     : 's__page1',
      lines    : ['s:L3', 's:L1', 's:L4', 's:L2'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    const panels = op.changed[0]!.panels!;
    expect(panels.flatMap((p) => p.coversLines)).toEqual(op.changed[0]!.coversLines);
  });

  it('moves a page’s panel lines when a neighbour takes one of them', () => {
    const op = setCoverage(board(), {
      shot     : 's__beat2',
      lines    : ['s:L3', 's:L4', 's:L5', 's:L6'],
      lineOrder: LINES,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.changed[1]).toEqual({
      id         : 's__page1',
      coversLines: ['s:L1', 's:L2'],
      panels     : [{ coversLines: ['s:L1'] }, { coversLines: ['s:L2'] }],
    });
  });
});

describe('applyCoverage', () => {
  it('writes the changed lines onto full shots and keeps every other field', () => {
    const full = board().map((s) => ({ ...s, framing: 'medium', status: 'pending' }));
    full[0]!.panels = full[0]!.panels!.map((p, i) => ({ ...p, shape: i }));
    const op = setCoverage(full, { shot: 's__page1', lines: ['s:L1', 's:L2'], lineOrder: LINES });
    if (!op.ok) throw new Error(op.error);
    const [page, frame] = applyCoverage(full, op.changed);
    expect(page).toEqual({
      id         : 's__page1',
      framing    : 'medium',
      status     : 'pending',
      coversLines: ['s:L1', 's:L2'],
      panels: [
        { shape: 0, coversLines: ['s:L1'] },
        { shape: 1, coversLines: ['s:L2'] },
      ],
    });
    expect(frame).toBe(full[1]);
  });
});

describe('letteredPagesNote', () => {
  const changed: CoverShot[] = [
    { id: 's__page1', coversLines: [], panels: [] },
    { id: 's__beat2', coversLines: [] },
  ];

  it('names the pages that re-render under model lettering, and nothing under runner', () => {
    expect(letteredPagesNote(changed, 'model')).toBe(
      ' s__page1 letters its lines, so it is drawn again on the next run.',
    );
    expect(letteredPagesNote(changed, 'runner')).toBe('');
  });

  it('is silent when only frames changed', () => {
    expect(letteredPagesNote([changed[1]!], 'model')).toBe('');
  });

  it('lists several pages in one sentence', () => {
    const two = [changed[0]!, { id: 's__page2', coversLines: [], panels: [] }];
    expect(letteredPagesNote(two, 'model')).toBe(
      ' s__page1, s__page2 letter their lines, so they are drawn again on the next run.',
    );
  });
});

describe('panelLines', () => {
  it('renames the lines a panel holds and drops the retired ones', () => {
    const panels = [{ coversLines: ['s:L1', 's:L2'], shape: 0 }, { coversLines: ['s:L3'] }];
    const keep = (id: string): string | undefined =>
      id === 's:L2' ? undefined : id === 's:L3' ? 't:L1' : id;
    expect(panelLines(panels, keep)).toEqual([
      { coversLines: ['s:L1'], shape: 0 },
      { coversLines: ['t:L1'] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The geometry, with its own fixture of four lines in the decomposer's interleaving. The line
// and shot shapes here are richer than the package's own (the desktop's projections carry prose
// and drift), which is what `spansFor`'s generics hand back unnarrowed.
// ---------------------------------------------------------------------------

interface RichLine {
  id: string;
  kind: 'narration' | 'dialogue';
  speaker?: string;
  text: string;
}

interface RichShot {
  id: string;
  framing: string;
  subjects: string[];
  outfits: Record<string, string>;
  coversLines: string[];
  drift: string;
}

const SCRIPT: RichLine[] = [
  { id: 's:L1', kind: 'narration', text: 'The roof, at dusk.' },
  { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 's:L3', kind: 'dialogue', speaker: 'ren', text: 'You came.' },
  { id: 's:L4', kind: 'narration', text: 'She bows, a little too deeply.' },
];

const drawn = (id: string, coversLines: string[]): RichShot => ({
  id,
  framing : 'medium',
  subjects: [],
  outfits : {},
  coversLines,
  drift: 'current',
});

const SHOTS: RichShot[] = [
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
    // The caller's own shot type comes back out, so fields the rules never read stay visible
    expect(est.shot.drift).toBe('current');
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
