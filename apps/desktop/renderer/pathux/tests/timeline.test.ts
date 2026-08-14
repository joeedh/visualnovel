import { spansFor } from '../../../src/shared/coverage.js';
import { TOP } from '../../../src/shared/interactions.js';
import { aimDrag, aimReorder, coverState, grabEdge, grabShot, noticeOf } from '../timeline.js';
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
  lines: LINES,
  shots: SHOTS,
  cast: [],
  decomposed: true,
};

const cov = spansFor(LINES, SHOTS);

describe('what a grab captures', () => {
  it('judges the whole scene once, so no pointer move re-decides anything', () => {
    const drag = grabEdge(data, 's__a', 'end');
    // Every row the drop would change, and only those: the rows `s__a` already ends on are not
    // targets at all, which is how "changes nothing" stays distinct from "refused".
    expect([...drag.verdicts.keys()].sort()).toEqual(['s:L1', 's:L3', 's:L4']);
    expect(drag.lines).toBeNull();
    expect(drag.verdict).toBeNull();
  });

  it('aims a reorder at itself, so a click that never moves commits nothing', () => {
    const reorder = grabShot(data, 's__b');
    expect(reorder.target).toBe('s__b');
    expect(reorder.verdict).toBeNull();
    // Not `s__a`: `s__b` already sits after it, so that drop is a noop and never a target — the
    // same distinction the edge drag draws between "changes nothing" and "refused".
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
    // Retracting `s__a`'s end onto row 0 releases `s:L2`, which becomes a gap — allowed.
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

    // The command's own refusal, verbatim — not a sentence this layer composed.
    expect(noticeOf(aimDrag(grabEdge(data, 's__a', 'end'), cov, 2))).toEqual({
      tone: 'refused',
      text: 'That would leave s__b covering nothing. Move its coverage somewhere else first.',
    });

    expect(noticeOf({ verdict: null })).toBeNull();
  });
});
