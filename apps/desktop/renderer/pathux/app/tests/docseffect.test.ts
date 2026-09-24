import { docsEffect, onReveal } from '../docseffect.js';
import type { SaveAllResult } from '../../doctree/docbuffer.js';

/** A Save All that records being run, and the sentences the dispatch said. */
function rig(result: SaveAllResult = { saved: [], refused: [] }) {
  const said: [string, boolean][] = [];
  let saves = 0;
  return {
    said,
    saves: () => saves,
    deps: {
      say : (text: string, bad = false) => void said.push([text, bad]),
      save: () => {
        saves++;
        return Promise.resolve(result);
      },
    },
  };
}

describe('docsEffect', () => {
  it('runs Save All for saveAll, and reports what it saved and what was refused', async () => {
    const r = rig({ saved: ['wiki/a.md'], refused: [{ path: 'wiki/b.md', reason: 'gone' }] });
    await docsEffect({ type: 'docs', action: 'saveAll' }, r.deps);
    expect(r.saves()).toBe(1);
    expect(r.said).toEqual([['Saved 1 document(s); refused — wiki/b.md: gone', true]]);
  });

  it('says so when there was nothing to save', async () => {
    const r = rig();
    await docsEffect({ type: 'docs', action: 'saveAll' }, r.deps);
    expect(r.said).toEqual([['Nothing to save.', false]]);
  });

  it('saves nothing for a reveal, and hands its paths to every listener', async () => {
    const r = rig();
    const heard: (readonly string[])[] = [];
    const off = onReveal((paths) => heard.push(paths));
    await docsEffect({ type: 'docs', action: 'reveal', paths: ['wiki/lore'] }, r.deps);
    off();
    await docsEffect({ type: 'docs', action: 'reveal', paths: ['wiki/other'] }, r.deps);
    expect(r.saves()).toBe(0);
    expect(r.said).toEqual([]);
    expect(heard).toEqual([['wiki/lore']]);
  });
});
