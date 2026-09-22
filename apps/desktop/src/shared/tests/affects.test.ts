import { UNDO_EXCLUDES, covers, declarable, snapshotted } from '../affects.js';

describe('covers', () => {
  it('matches a path against the subtree it sits in', () => {
    expect(covers(['scenes'], 'scenes/opening.md')).toBe(true);
    expect(covers(['vngen/work/graphs'], 'vngen/work/graphs/hero.json')).toBe(true);
  });

  it('matches a prefix naming exactly one file', () => {
    expect(covers(['project.yaml'], 'project.yaml')).toBe(true);
  });

  it('tolerates a reported directory, which one command produces', () => {
    expect(covers(['vngen'], 'vngen/work/shots/')).toBe(true);
  });

  it('normalizes backslashes and a leading ./ before comparing', () => {
    expect(covers(['scenes'], 'scenes\\opening.md')).toBe(true);
    expect(covers(['scenes'], './scenes/opening.md')).toBe(true);
  });

  it('does not let a sibling share a textual prefix', () => {
    expect(covers(['scenes'], 'scenes2/opening.md')).toBe(false);
  });

  it('answers false for an empty path and for an empty declaration', () => {
    expect(covers(['scenes'], '')).toBe(false);
    expect(covers([], 'scenes/opening.md')).toBe(false);
  });
});

describe('declarable', () => {
  it('accepts a root and anything under one', () => {
    expect(declarable('scenes')).toBe(true);
    expect(declarable('vngen/work/shots')).toBe(true);
    expect(declarable('<user>/plugins')).toBe(true);
  });

  it('refuses a prefix outside the vocabulary', () => {
    expect(declarable('scene')).toBe(false);
    expect(declarable('.')).toBe(false);
  });

  it('refuses a malformed prefix rather than repairing it', () => {
    expect(declarable('scenes/')).toBe(false);
    expect(declarable('./scenes')).toBe(false);
    expect(declarable('scenes\\opening')).toBe(false);
    expect(declarable('')).toBe(false);
  });
});

describe('snapshotted', () => {
  it('answers false for each exclusion and for a path nested inside one', () => {
    for (const exclude of UNDO_EXCLUDES) expect(snapshotted(exclude)).toBe(false);
    expect(snapshotted('vngen/state/journal')).toBe(false);
    expect(snapshotted('keys/openai.key')).toBe(false);
    expect(snapshotted('.gitmodules')).toBe(false);
  });

  it('answers false for the repository itself, which is history rather than documents', () => {
    expect(declarable('<git>')).toBe(true);
    expect(snapshotted('<git>')).toBe(false);
  });

  it('answers false for a user-level prefix, which no workspace snapshot reaches', () => {
    expect(snapshotted('<user>')).toBe(false);
    expect(snapshotted('<user>/plugins')).toBe(false);
  });

  it('answers true for a prefix that merely contains an exclusion', () => {
    expect(snapshotted('vngen')).toBe(true);
    expect(snapshotted('.vnstudio')).toBe(true);
  });

  it('answers true for the document class', () => {
    expect(snapshotted('scenes')).toBe(true);
    expect(snapshotted('vngen/work/graphs')).toBe(true);
  });
});
