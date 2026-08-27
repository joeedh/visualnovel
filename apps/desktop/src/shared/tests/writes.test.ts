import { graphDocPath, normalizePath, touches, touchesGraph, touchesScene } from '../writes.js';

describe('normalizePath', () => {
  it('forward-slashes and drops a ./ prefix', () => {
    expect(normalizePath('wiki\\lore\\houses.md')).toBe('wiki/lore/houses.md');
    expect(normalizePath('./characters/aiko/character.md')).toBe('characters/aiko/character.md');
  });
});

describe('touches', () => {
  it('matches a written path however it was spelled', () => {
    expect(touches(['wiki/lore/houses.md'], 'wiki/lore/houses.md')).toBe(true);
    expect(touches(['wiki\\lore\\houses.md'], 'wiki/lore/houses.md')).toBe(true);
    expect(touches(['./wiki/lore/houses.md'], 'wiki/lore/houses.md')).toBe(true);
  });

  it('does not match a different file, a prefix of one, or nothing open', () => {
    expect(touches(['wiki/lore/houses.md'], 'wiki/lore/house.md')).toBe(false);
    expect(touches(['wiki/lore/houses.md.bak'], 'wiki/lore/houses.md')).toBe(false);
    expect(touches(['wiki/lore/houses.md'], '')).toBe(false);
    expect(touches([], 'wiki/lore/houses.md')).toBe(false);
  });
});

describe('touchesScene', () => {
  it('derives the scene file from the id', () => {
    expect(touchesScene(['scenes/rooftop.md'], 'rooftop')).toBe(true);
    expect(touchesScene(['scenes\\rooftop.md'], 'rooftop')).toBe(true);
  });

  it('ignores another scene, another file, and no scene open', () => {
    expect(touchesScene(['scenes/hallway.md'], 'rooftop')).toBe(false);
    expect(touchesScene(['characters/aiko/character.md'], 'rooftop')).toBe(false);
    expect(touchesScene(['scenes/rooftop.md'], '')).toBe(false);
  });
});

describe('graphDocPath', () => {
  // Pinned against the path a write actually reports, which is what `writeGraphDoc` returns from
  // `graphPath`. A bare `work/graphs/...` here matched nothing the app ever wrote.
  it('is under vngen/, the way ProjectPaths.work is', () => {
    expect(graphDocPath('portrait')).toBe('vngen/work/graphs/portrait.json');
  });
});

describe('touchesGraph', () => {
  it('derives the graph file from the slug', () => {
    expect(touchesGraph(['vngen/work/graphs/portrait.json'], 'portrait')).toBe(true);
    expect(touchesGraph(['vngen\\work\\graphs\\portrait.json'], 'portrait')).toBe(true);
  });

  it('ignores another graph, another file, and no graph open', () => {
    expect(touchesGraph(['vngen/work/graphs/backdrop.json'], 'portrait')).toBe(false);
    expect(touchesGraph(['characters/aiko/character.md'], 'portrait')).toBe(false);
    expect(touchesGraph(['vngen/work/graphs/portrait.json'], '')).toBe(false);
  });
});
