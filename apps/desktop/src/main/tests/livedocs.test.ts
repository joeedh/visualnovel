import { LiveDocs } from '../livedocs.js';

const GRAPH = 'vngen/work/graphs/plates.json';
const SCENE = 'scenes/rooftop.md';

describe('LiveDocs', () => {
  it('reads a document nothing has written as version zero', () => {
    expect(new LiveDocs().version(GRAPH)).toBe(0);
  });

  it('counts each document on its own', () => {
    const docs = new LiveDocs();
    docs.wrote([GRAPH]);
    docs.wrote([GRAPH]);
    docs.wrote([SCENE]);
    expect(docs.version(GRAPH)).toBe(2);
    expect(docs.version(SCENE)).toBe(1);
  });

  it('answers the versions a write produced, so the writer can recognize its own echo', () => {
    const docs = new LiveDocs();
    expect(docs.wrote([GRAPH, SCENE])).toEqual({ [GRAPH]: 1, [SCENE]: 1 });
    expect(docs.wrote([GRAPH])).toEqual({ [GRAPH]: 2 });
  });

  it('reports without stamping', () => {
    const docs = new LiveDocs();
    docs.wrote([GRAPH]);
    expect(docs.current([GRAPH, SCENE])).toEqual({ [GRAPH]: 1, [SCENE]: 0 });
    expect(docs.version(GRAPH)).toBe(1);
  });

  it('stamps nothing for a write that named no paths', () => {
    expect(new LiveDocs().wrote([])).toEqual({});
  });

  // The keys are workspace-relative, so under another root the same key names another file and a
  // surviving count would tell a pane its copy of that file was current.
  it('forgets every version when the workspace switches', () => {
    const docs = new LiveDocs();
    docs.wrote([GRAPH]);
    docs.clear();
    expect(docs.version(GRAPH)).toBe(0);
  });
});
