import { spansFor } from '@vn/scriptedit';
import { TOP } from '../../../src/shared/interactions.js';
import {
  aimCreate,
  aimDrag,
  aimReorder,
  coverState,
  grabEdge,
  grabGutter,
  grabShot,
  noticeOf,
} from '../timeline.js';
import type { CoverageLine, CoverageShot, SceneCoverage } from '../../../src/shared/ipc';

const LINES: CoverageLine[] = [
  { id: 's:L1', kind: 'narration', text: 'The roof, at dusk.' },
  { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 's:L3', kind: 'dialogue', speaker: 'ren', text: 'You came.' },
  { id: 's:L4', kind: 'narration', text: 'She bows, a little too deeply.' },
];

const shot = (id: string, coversLines: string[]): CoverageShot => ({
  id,
  framing: 'medium',
  subjects: [],
  location: 'day',
  outfits: {},
  coversLines,
  status: 'accepted',
  drift: 'current',
});

const SHOTS: CoverageShot[] = [
  shot('s__a', ['s:L1', 's:L2']),
  shot('s__b', ['s:L3']),
  shot('s__c', ['s:L4']),
];

const data: SceneCoverage = {
  sceneId: 's',
  location: 'roof',
  heading: 'EXT. ROOF - NIGHT',
  lines: LINES,
  shots: SHOTS,
  cast: [],
  characters: [],
  variants: ['day'],
  decomposed: true,
};

const cov = spansFor(LINES, SHOTS);

describe('what a grab captures', () => {
  it('judges the whole scene once, so no pointer move re-decides anything', () => {
    const drag = grabEdge(data, 's__a', 'end');
    // Only the rows the drop would change are targets. The rows `s__a` already ends on are not
    // targets, which keeps "changes nothing" distinct from "refused"
    expect([...drag.verdicts.keys()].sort()).toEqual(['s:L1', 's:L3', 's:L4']);
    expect(drag.lines).toBeNull();
    expect(drag.verdict).toBeNull();
  });

  it('aims a reorder at itself, so a click that never moves commits nothing', () => {
    const reorder = grabShot(data, 's__b');
    expect(reorder.target).toBe('s__b');
    expect(reorder.verdict).toBeNull();
    // `s__a` is not a target because `s__b` already sits after it, so that drop changes nothing.
    // This is the same distinction the edge drag draws between "changes nothing" and "refused"
    expect([...reorder.verdicts.keys()].sort()).toEqual(['s__c', TOP]);
  });

  it('reports the gesture unresolved rather than throwing on a shot that is not there', () => {
    const reorder = grabShot(data, 's__gone');
    expect([...reorder.verdicts.values()].every((v) => !v.accept)).toBe(true);
  });

  it('survives no coverage loaded at all', () => {
    expect(coverState(null)).toEqual({ sceneId: '', lines: [], shots: [] });
    expect(grabEdge(null, 's__a', 'start').verdicts.size).toBe(1);
  });
});

describe('aiming a drag at a row', () => {
  it('carries the geometry and the verdict for that row together', () => {
    // Retracting `s__a`'s end onto row 0 releases `s:L2` into a gap, which is allowed
    const drag = aimDrag(grabEdge(data, 's__a', 'end'), cov, 0);
    expect(drag.lines).toEqual(['s:L1']);
    expect(drag.verdict?.accept).toBe(true);
  });

  it('draws nothing over a row the grab did not judge', () => {
    // Row 1 is where `s__a` already ends, so the drop changes nothing and is not a target.
    const drag = aimDrag(grabEdge(data, 's__a', 'end'), cov, 1);
    expect(drag.lines).toBeNull();
    expect(drag.verdict).toBeNull();
  });

  it('keeps the refusal and its geometry, so a refused drop is still drawn', () => {
    // Sweeping `s__a`'s end over `s__b`'s only line would leave `s__b` covering nothing.
    const drag = aimDrag(grabEdge(data, 's__a', 'end'), cov, 2);
    expect(drag.lines).toEqual(['s:L1', 's:L2', 's:L3']);
    expect(drag.verdict?.accept).toBe(false);
  });

  it('answers a row off the end of the scene as no target', () => {
    expect(aimDrag(grabEdge(data, 's__a', 'end'), cov, 99).verdict).toBeNull();
  });
});

describe('the gutter sweep that makes a shot', () => {
  it('judges every line at the grab, the anchor row included — a one-line shot is a real act', () => {
    const create = grabGutter(data, 's:L2');
    expect([...create.verdicts.keys()].sort()).toEqual(['s:L1', 's:L2', 's:L3', 's:L4']);
    expect(create.lines).toBeNull();
    expect(create.verdict).toBeNull();
  });

  it('sweeps anchor-to-row inclusive, in row order, whichever way the drag went', () => {
    const down = aimCreate(grabGutter(data, 's:L2'), cov, 3);
    expect(down.lines).toEqual(['s:L2', 's:L3', 's:L4']);
    const up = aimCreate(grabGutter(data, 's:L4'), cov, 1);
    expect(up.lines).toEqual(['s:L2', 's:L3', 's:L4']);
  });

  it('carries the id the write would actually mint, off the persisted mark', () => {
    // The persisted mark outranks derivation, so the id is shot4 even though only a, b and c
    // exist. A retired id must never be re-minted.
    const marked: SceneCoverage = { ...data, nextShot: 4 };
    const aimed = aimCreate(grabGutter(marked, 's:L1'), cov, 0);
    expect(aimed.verdict?.accept).toBe(true);
    expect(noticeOf(aimed)?.text).toContain('s__shot4');
  });

  it('keeps a refusal and its sweep together, so a refused drop is still drawn', () => {
    // Claiming every line would leave all three shots covering nothing. The refusal is the same
    // sentence a coverage drag gets.
    const aimed = aimCreate(grabGutter(data, 's:L1'), cov, 3);
    expect(aimed.lines).toEqual(['s:L1', 's:L2', 's:L3', 's:L4']);
    expect(aimed.verdict?.accept).toBe(false);
  });

  it('answers a row off the end of the scene as no target', () => {
    expect(aimCreate(grabGutter(data, 's:L1'), cov, 99).verdict).toBeNull();
  });
});

describe('aiming a reorder at a row', () => {
  it('resolves the row to an insertion point and reads its verdict off', () => {
    const aimed = aimReorder(grabShot(data, 's__c'), cov.spans, 0);
    expect(aimed.target).toBe(TOP);
    expect(aimed.verdict?.accept).toBe(true);
  });

  it('says nothing while the pointer is over the shot being dragged', () => {
    const aimed = aimReorder(grabShot(data, 's__a'), cov.spans, 1);
    expect(aimed.target).toBe('s__a');
    expect(aimed.verdict).toBeNull();
  });
});

describe('what the author is told', () => {
  it('is the verdict’s own sentence, or nothing where there is no candidate', () => {
    expect(noticeOf(aimDrag(grabEdge(data, 's__a', 'end'), cov, 0))).toEqual({
      tone: 'preview',
      text: 's__a covers 1 line(s).',
    });

    // The text is the command's own refusal, verbatim, rather than a sentence composed here
    expect(noticeOf(aimDrag(grabEdge(data, 's__a', 'end'), cov, 2))).toEqual({
      tone: 'refused',
      text: 'That would leave s__b covering nothing. Move its coverage somewhere else first.',
    });

    expect(noticeOf({ verdict: null })).toBeNull();
  });
});
