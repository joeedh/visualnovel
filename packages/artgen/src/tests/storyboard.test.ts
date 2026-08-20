/**
 * `realizeDecomposition` directly, the checks `decomposeScene` and `write_storyboard` share.
 * Subject resolution and coverage repair are exercised through `decomposeScene` in the pipeline's
 * tests. This file covers the parts the export added: id namespacing that does not stack, and the
 * baseline answer for an empty shot list.
 */
import type { ProjectModel, Scene } from '@vn/types';
import { realizeDecomposition } from '../storyboard.js';

const SCENE: Scene = {
  id: 'epilogue',
  location: 'classroom',
  characters: [],
  lines: [{ id: 'epilogue:L1', kind: 'narration', text: 'Morning light.' }],
  choices: [],
  shots: [],
};

const MODEL: ProjectModel = {
  title: 'T',
  characters: new Map(),
  locations: new Map([
    [
      'classroom',
      {
        id: 'classroom',
        name: 'Classroom 2-B',
        description: 'A classroom',
        palette: [],
        variants: [{ id: 'day', description: 'daylight' }],
        mined: false,
      },
    ],
  ]),
  scenes: new Map([['epilogue', SCENE]]),
  reachable: new Set(['epilogue']),
  entry: 'epilogue',
  diagnostics: [],
};

const shot = (id: string) => ({
  id,
  framing: 'medium' as const,
  location: 'day',
  subjects: [],
  coversLines: ['epilogue:L1'],
});

describe('realizeDecomposition', () => {
  it('namespaces a raw id and keeps an already-namespaced one, so a read-back does not stack', () => {
    const first = realizeDecomposition({ shots: [shot('opener')] }, SCENE, MODEL);
    expect(first.source).toBe('model');
    expect(first.shots[0]!.id).toBe('epilogue__opener');

    // A proposal restated to `write_storyboard` arrives with the prefix it was shown with.
    const again = realizeDecomposition({ shots: first.shots.map((s) => shot(s.id)) }, SCENE, MODEL);
    expect(again.shots[0]!.id).toBe('epilogue__opener');
  });

  it('answers an empty list with the baseline, naming why', () => {
    const result = realizeDecomposition({ shots: [] }, SCENE, MODEL);
    expect(result.source).toBe('baseline');
    expect(result.reason).toContain('no shots');
    expect(result.shots.length).toBeGreaterThan(0);
  });
});
