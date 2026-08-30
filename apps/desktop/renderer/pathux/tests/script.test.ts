import { TOP } from '../../../src/shared/interactions.js';
import {
  aim,
  dropOf,
  grabLine,
  lineMenu,
  noticeOf,
  shotAssetEntry,
  shotCovering,
} from '../script.js';
import type { CoverageLine, CoverageShot, SceneCoverage } from '../../../src/shared/ipc';

const lines: CoverageLine[] = [
  { id: 'a:L1', kind: 'narration', text: 'The gate stands open.' },
  { id: 'a:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 'a:L3', kind: 'narration', text: 'Nobody answers.' },
];

const scene: SceneCoverage = {
  sceneId: 'a',
  location: 'GATE',
  heading: 'INT. GATE - DAY',
  lines,
  shots: [],
  cast: [],
  characters: [],
  variants: ['day'],
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

describe('what right-clicking a line offers', () => {
  const shot = (id: string, covers: string[], image?: CoverageShot['image']): CoverageShot => ({
    id,
    framing: 'medium',
    subjects: [],
    location: 'day',
    outfits: {},
    coversLines: covers,
    status: 'accepted',
    image,
    drift: 'current',
  });
  const drawn = shot('a:S1', ['a:L1', 'a:L2'], { hash: 'abc123', ext: 'png' });
  const bare = shot('a:S2', ['a:L3']);
  const covered: SceneCoverage = { ...scene, shots: [drawn, bare] };

  test('a line is covered by the one shot whose bracket includes it', () => {
    expect(shotCovering(covered.shots, 'a:L2')).toBe(drawn);
    expect(shotCovering(covered.shots, 'a:L3')).toBe(bare);
    expect(shotCovering(covered.shots, 'a:L9')).toBeNull();
  });

  test('a drawn shot opens its frame by hash, elsewhere', () => {
    expect(lineMenu(covered, 'a:L1')).toEqual([
      { label: 'Edit with agent', id: 'agent.editLine', props: { scene: 'a', line: 'a:L1' } },
      {
        label: 'Open shot asset',
        id: 'view.open',
        props: { editor: 'asset', where: 'elsewhere', subject: 'abc123' },
      },
    ]);
  });

  // It names the line rather than pre-judging anything, so `check` is asked whatever the art says
  test('the agent entry is offered on every line, drawn or not', () => {
    for (const from of [scene, covered]) {
      const [entry] = lineMenu(from, 'a:L3');
      expect(entry?.id).toBe('agent.editLine');
      expect(entry?.refused).toBeUndefined();
    }
  });

  test('a shot with no frame yet says so rather than vanishing', () => {
    const [, entry] = lineMenu(covered, 'a:L3');
    expect(entry?.props).toBeUndefined();
    expect(entry?.refused).toContain('a:S2');
    expect(entry?.refused).toContain('has not been drawn');
  });

  test('a line no shot covers is a different answer, and it is also said', () => {
    // A line with no shot and a shot with no frame are different states: one is fixed by
    // decomposing the scene, the other by running it.
    const [, entry] = lineMenu(scene, 'a:L1');
    expect(entry?.refused).toBe('No shot covers a:L1 yet.');
  });

  // Shot Coverage right-clicks a bracket, which names the shot outright, so it takes the entry
  // without the line the script column has to look one up from.
  test('a bracket asks for the same entry, refusing in the words its own surface uses', () => {
    expect(shotAssetEntry(drawn, 'Open shot asset', 'never asked')).toEqual({
      label: 'Open shot asset',
      id: 'view.open',
      props: { editor: 'asset', where: 'elsewhere', subject: 'abc123' },
    });
    const refused = shotAssetEntry(bare, 'Open shot asset', 'a:S2 has no frame yet.');
    expect(refused.props).toBeUndefined();
    expect(refused.refused).toBe('a:S2 has no frame yet.');
  });
});
