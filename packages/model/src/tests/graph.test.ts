import type { Scene } from '@vn/types';
import { topologicalOrder } from '../graph.js';

/** A scene with only its edges: `next`, then the choices' targets. */
function scene(id: string, next?: string, ...gotos: string[]): [string, Scene] {
  return [
    id,
    {
      id,
      location  : 'cafe',
      characters: [],
      lines     : [],
      shots     : [],
      choices   : gotos.map((goto) => ({ label: goto, goto })),
      ...(next === undefined ? {} : { next }),
    },
  ];
}

describe('topologicalOrder', () => {
  it('puts a scene after every scene that leads to it, whatever the stored order', () => {
    // Stored alphabetically, which is neither the reading order nor a topological one
    const scenes = new Map([
      scene('end'),
      scene('fork', undefined, 'left', 'right'),
      scene('left', 'merge'),
      scene('merge', 'end'),
      scene('right', 'merge'),
      scene('start', 'fork'),
    ]);
    expect(topologicalOrder(scenes, 'start')).toEqual([
      'start',
      'fork',
      'left',
      'right',
      'merge',
      'end',
    ]);
  });

  it('holds a scene back until a longer path to it has been walked', () => {
    // Breadth-first from `a` would meet `b` before `c`, but `c` leads to `b`
    const scenes = new Map([scene('a', 'b', 'c'), scene('c', 'b'), scene('b')]);
    expect(topologicalOrder(scenes, 'a')).toEqual(['a', 'c', 'b']);
  });

  it('breaks a loop at the scene discovered earliest and leaves out what the entry never reaches', () => {
    const scenes = new Map([
      scene('lost', 'loop'),
      scene('start', 'loop'),
      scene('loop', 'again'),
      scene('again', 'loop', 'out'),
      scene('out'),
    ]);
    expect(topologicalOrder(scenes, 'start')).toEqual(['start', 'loop', 'again', 'out']);
  });

  it('is empty without an entry the scenes hold', () => {
    const scenes = new Map([scene('a', 'b'), scene('b')]);
    expect(topologicalOrder(scenes, undefined)).toEqual([]);
    expect(topologicalOrder(scenes, 'missing')).toEqual([]);
  });
});
