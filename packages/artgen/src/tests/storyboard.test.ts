/**
 * `realizeDecomposition` directly, the checks `decomposeScene` and `write_storyboard` share.
 * Subject resolution and coverage repair are exercised through `decomposeScene` in the pipeline's
 * tests. This file covers the parts the export added: id namespacing that does not stack, and the
 * baseline answer for an empty shot list.
 */
import type { ProjectModel, Scene } from '@vn/types';
import { character } from '@vn/testkit';
import { realizeDecomposition } from '../storyboard.js';

const SCENE: Scene = {
  id        : 'epilogue',
  location  : 'classroom',
  characters: [],
  lines     : [{ id: 'epilogue:L1', kind: 'narration', text: 'Morning light.' }],
  choices   : [],
  shots     : [],
};

const MODEL: ProjectModel = {
  title      : 'T',
  characters : new Map(),
  locations: new Map([
    [
      'classroom',
      {
        id         : 'classroom',
        name       : 'Classroom 2-B',
        description: 'A classroom',
        palette    : [],
        variants   : [{ id: 'day', description: 'daylight' }],
        mined      : false,
      },
    ],
  ]),
  scenes     : new Map([['epilogue', SCENE]]),
  reachable  : new Set(['epilogue']),
  entry      : 'epilogue',
  diagnostics: [],
};

const shot = (id: string) => ({
  id,
  framing    : 'medium' as const,
  location   : 'day',
  subjects   : [],
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

describe('realizeDecomposition on a page', () => {
  const aiko = character('aiko', 'approved', 'sha-aiko');
  const ren = character('ren', 'approved', 'sha-ren');
  const scene: Scene = {
    ...SCENE,
    characters: ['aiko', 'ren'],
    lines: [
      { id: 'epilogue:L1', kind: 'narration', text: 'Morning light.' },
      { id: 'epilogue:L2', kind: 'dialogue', speaker: 'aiko', text: 'You came.' },
      { id: 'epilogue:L3', kind: 'dialogue', speaker: 'ren', text: 'I said I would.' },
    ],
  };
  const model: ProjectModel = {
    ...MODEL,
    characters: new Map([
      ['aiko', aiko],
      ['ren', ren],
    ]),
    scenes    : new Map([['epilogue', scene]]),
  };
  const panel = (framing: 'wide' | 'close', who: string[], lines: string[]) => ({
    framing,
    subjects   : who.map((characterId) => ({ characterId })),
    coversLines: lines,
  });

  it('lays out named panels, derives the page’s cast and coverage from them, and partitions the lines', () => {
    const { shots } = realizeDecomposition(
      {
        shots: [
          {
            id         : 'page1',
            location   : 'day',
            subjects   : [],
            layout     : 'two-tier',
            panels: [
              panel('wide', [], ['epilogue:L1']),
              panel('close', ['Aiko'], ['epilogue:L2']),
              // L2 again, and an invented id: the first panel keeps L2 and L9 is dropped
              panel('close', ['ren', 'nobody'], ['epilogue:L2', 'epilogue:L3', 'epilogue:L9']),
              panel('wide', ['aiko', 'ren'], []),
            ],
            coversLines: [],
          },
        ],
      },
      scene,
      model,
    );
    const page = shots[0]!;
    expect(page.panels).toHaveLength(4);
    expect(page.panels!.map((p) => p.shape[0])).toEqual([
      [0, 0],
      [0.5, 0],
      [0, 0.5],
      [0.5, 0.5],
    ]);
    expect(page.panels!.map((p) => p.coversLines)).toEqual([
      ['epilogue:L1'],
      ['epilogue:L2'],
      ['epilogue:L3'],
      [],
    ]);
    expect(page.panels![2]!.subjects).toEqual([{ characterId: 'ren' }]);
    // The page framing is its first panel's, and its cast the union of the panels' in order
    expect(page.framing).toBe('wide');
    expect(page.subjects.map((s) => s.characterId)).toEqual(['aiko', 'ren']);
    expect(page.coversLines).toEqual(['epilogue:L1', 'epilogue:L2', 'epilogue:L3']);
  });

  it('keeps outlines the panels drew themselves, and splits an unnamed page evenly', () => {
    const tri: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    const { shots } = realizeDecomposition(
      {
        shots: [
          {
            id         : 'drawn',
            location   : 'day',
            subjects   : [],
            panels     : [{ ...panel('wide', [], ['epilogue:L1']), shape: tri }],
            coversLines: [],
          },
          {
            id         : 'even',
            location   : 'day',
            subjects   : [],
            panels: [
              panel('wide', [], ['epilogue:L2']),
              panel('close', [], ['epilogue:L3']),
              panel('close', [], []),
            ],
            coversLines: [],
          },
        ],
      },
      scene,
      model,
    );
    expect(shots[0]!.panels![0]!.shape).toEqual(tri);
    expect(shots[1]!.panels!.map((p) => p.shape[2])).toEqual([
      [0.5, 0.5],
      [1, 0.5],
      [1, 1],
    ]);
  });

  it('opens the first panel on the scene’s first line when the repair adds it', () => {
    const { shots } = realizeDecomposition(
      {
        shots: [
          {
            id         : 'page1',
            location   : 'day',
            subjects   : [],
            panels     : [panel('close', [], ['epilogue:L2']), panel('close', [], [])],
            coversLines: [],
          },
        ],
      },
      scene,
      model,
    );
    expect(shots[0]!.coversLines).toEqual(['epilogue:L1', 'epilogue:L2']);
    expect(shots[0]!.panels![0]!.coversLines).toEqual(['epilogue:L1', 'epilogue:L2']);
  });

  it('carries the proposed staging groups only beside a model answer', () => {
    const sheets = { staging: { seed: 1 } };
    const shot = { id: 'a', location: 'day', subjects: [], coversLines: ['epilogue:L1'] };
    expect(realizeDecomposition({ shots: [shot], sheets }, scene, model).sheets).toEqual(sheets);
    expect(realizeDecomposition({ shots: [], sheets }, scene, model).sheets).toBeUndefined();
  });
});
