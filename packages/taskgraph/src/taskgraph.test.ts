import type { ImageParams } from '@vn/types';
import { makeTask, taskHash, TaskGraph } from './index.js';

const params: ImageParams = { modelId: 'gemini-2.5-flash-image', aspect: '16:9' };

describe('content-addressed dedupe', () => {
  it('identical inputs collapse to the same hash', () => {
    const a = taskHash('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params });
    const b = taskHash('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params });
    expect(a).toBe(b);
  });

  it('different inputs (or kinds) produce different hashes', () => {
    const a = taskHash('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params });
    const b = taskHash('portrait', { characterId: 'aiko', prompt: 'DIFFERENT', refs: [], params });
    expect(a).not.toBe(b);
  });

  it('graph.add dedupes by hash', () => {
    const g = new TaskGraph();
    const t1 = makeTask('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params });
    const t2 = makeTask('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params });
    g.add(t1);
    const canonical = g.add(t2);
    expect(g.all()).toHaveLength(1);
    expect(canonical.hash).toBe(t1.hash);
  });
});

describe('readiness and gates', () => {
  it('a task is ready only once all deps are done', () => {
    const g = new TaskGraph();
    const portrait = g.add(
      makeTask('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params }),
    );
    const sheet = g.add(
      makeTask(
        'model_sheet',
        { characterId: 'aiko', outfit: 'default', angle: 'front', prompt: 's', refs: [], params },
        [portrait.hash],
      ),
    );

    expect(g.ready().map((t) => t.hash)).toEqual([portrait.hash]);
    g.setStatus(portrait.hash, 'done', { output: 'abc' });
    expect(g.ready().map((t) => t.hash)).toEqual([sheet.hash]);
    g.setStatus(sheet.hash, 'done');
    expect(g.ready()).toHaveLength(0);
  });
});

describe('topological order', () => {
  it('orders dependencies before dependents', () => {
    const g = new TaskGraph();
    const a = g.add(makeTask('portrait', { characterId: 'a', prompt: 'p', refs: [], params }));
    const b = g.add(
      makeTask(
        'model_sheet',
        { characterId: 'a', outfit: 'd', angle: 'f', prompt: 's', refs: [], params },
        [a.hash],
      ),
    );
    const order = g.topoOrder();
    expect(order.indexOf(a.hash)).toBeLessThan(order.indexOf(b.hash));
  });

  it('throws on a cycle', () => {
    const g = new TaskGraph();
    const a = g.add(makeTask('portrait', { characterId: 'a', prompt: 'p', refs: [], params }));
    const b = g.add(makeTask('portrait', { characterId: 'b', prompt: 'p', refs: [], params }));
    a.deps.push(b.hash);
    b.deps.push(a.hash);
    expect(() => g.topoOrder()).toThrow(/cycle/);
  });
});

describe('staleness', () => {
  it('prune drops orphaned tasks, leaving untouched branches alone', () => {
    const g = new TaskGraph();
    const keep = g.add(makeTask('portrait', { characterId: 'a', prompt: 'p', refs: [], params }));
    const stale = g.add(
      makeTask('portrait', { characterId: 'b', prompt: 'OLD', refs: [], params }),
    );
    const removed = g.prune(new Set([keep.hash]));
    expect(removed).toEqual([stale.hash]);
    expect(g.all().map((t) => t.hash)).toEqual([keep.hash]);
  });
});
