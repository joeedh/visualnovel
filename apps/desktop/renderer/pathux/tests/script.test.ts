import { TOP } from '../../../src/shared/interactions.js';
import { aim, dropOf, grabLine, noticeOf } from '../script.js';
import type { CoverageLine, SceneCoverage } from '../../../src/shared/ipc';

const lines: CoverageLine[] = [
  { id: 'a:L1', kind: 'narration', text: 'The gate stands open.' },
  { id: 'a:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 'a:L3', kind: 'narration', text: 'Nobody answers.' },
];

const scene: SceneCoverage = {
  sceneId: 'a',
  location: 'GATE',
  lines,
  shots: [],
  cast: [],
  decomposed: false,
};

describe('what a grab captures', () => {
  test('every insertion point is judged, before the line has moved', () => {
    const drag = grabLine(scene, 'a:L2');
    // `TOP` and "after L3" reorder; "after L1" is where it already is, so it is not a target.
    expect([...drag.verdicts.keys()].sort()).toEqual(['a:L3', TOP]);
    expect(drag.over).toBeNull();
    expect(drag.verdict).toBeNull();
  });

  test('a line the scene does not have is refused as a whole gesture', () => {
    const drag = grabLine(scene, 'a:L9');
    expect([...drag.verdicts.values()].every((v) => !v.accept)).toBe(true);
    expect(dropOf(drag)).toBeNull();
  });
});

describe('aiming it at an insertion point', () => {
  const held = grabLine(scene, 'a:L2');

  test('the drop runs the verdict’s own invocation', () => {
    const drag = aim(held, TOP);
    expect(drag.over).toBe(TOP);
    expect(dropOf(drag)).toEqual({ id: 'story.moveLine', props: { line: 'a:L2', after: '' } });
    expect(noticeOf(drag)).toEqual({ tone: 'preview', text: expect.any(String) });
  });

  test('after a line is that line’s id, not its index', () => {
    expect(dropOf(aim(held, 'a:L3'))).toEqual({
      id: 'story.moveLine',
      props: { line: 'a:L2', after: 'a:L3' },
    });
  });

  test('an insertion point that would reorder nothing has no rule and no sentence', () => {
    const drag = aim(held, 'a:L1');
    expect(drag.over).toBe('a:L1');
    expect(drag.verdict).toBeNull();
    expect(noticeOf(drag)).toBeNull();
    expect(dropOf(drag)).toBeNull();
  });

  test('off the page there is nothing under the pointer at all', () => {
    expect(aim(aim(held, TOP), null).verdict).toBeNull();
    expect(noticeOf(null)).toBeNull();
  });
});
