import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { hasConflictMarkers } from '@vn/util';
import { decisionOf, parseStages, type Git } from '../index.js';
import { tempRepo, write } from './helpers.js';

describe('parseStages and decisionOf', () => {
  const lines =
    '100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\ta.txt\n' +
    '100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2\ta.txt\n' +
    '100644 cccccccccccccccccccccccccccccccccccccccc 3\ta.txt\n' +
    '100644 dddddddddddddddddddddddddddddddddddddddd 1\tdir/b c.txt\n' +
    '100644 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee 3\tdir/b c.txt\n';

  it('groups the stage lines by path, keeping a space in the path', () => {
    expect(parseStages(lines)).toEqual([
      { path: 'a.txt', stages: { 1: 'a'.repeat(40), 2: 'b'.repeat(40), 3: 'c'.repeat(40) } },
      { path: 'dir/b c.txt', stages: { 1: 'd'.repeat(40), 3: 'e'.repeat(40) } },
    ]);
    expect(parseStages('')).toEqual([]);
  });

  it('reads a decision off the blob the index holds now', () => {
    const stages = { 1: 'a', 2: 'b', 3: 'c' };
    expect(decisionOf(stages, 'b')).toBe('ours');
    expect(decisionOf(stages, 'c')).toBe('theirs');
    expect(decisionOf(stages, 'x')).toBe('merged');
    expect(decisionOf(stages, null)).toBe('removed');
  });
});

describe('a decided path and its resolve-undo record', () => {
  /**
   * `main` and `theirs` diverge from a base. The author's first save changes `a.txt`, which
   * `theirs` also changed; the second changes `b.txt` and brings back `c.txt`, which `theirs`
   * removed, so a rebase stops twice.
   */
  async function diverged(): Promise<{ git: Git; dir: string; cleanup: () => Promise<void> }> {
    const a = await tempRepo();
    await write(a.dir, 'a.txt', 'base\n');
    await write(a.dir, 'b.txt', 'base\n');
    await write(a.dir, 'c.txt', 'base\n');
    await a.git.commit({ message: 'Base', paths: ['-A'] });
    const base = (await a.git.head())!;
    await write(a.dir, 'a.txt', 'theirs\n');
    await write(a.dir, 'b.txt', 'theirs\n');
    await fs.rm(join(a.dir, 'c.txt'));
    await a.git.add(['-A']);
    await a.git.updateRef(
      'refs/heads/theirs',
      await a.git.commitTree(await a.git.writeTree(), { message: 'Theirs', parents: [base] }),
    );
    await a.git.restore('.', 'HEAD');
    await write(a.dir, 'a.txt', 'mine\n');
    await a.git.commit({ message: 'Mine 1', paths: ['-A'] });
    await write(a.dir, 'b.txt', 'mine\n');
    await write(a.dir, 'c.txt', 'mine\n');
    await a.git.commit({ message: 'Mine 2', paths: ['-A'] });
    return a;
  }

  it('remembers a merge written by hand, says so, and puts the conflict back on request', async () => {
    const a = await diverged();
    try {
      expect(await a.git.rebase('theirs')).toBe(false);
      expect(await a.git.resolvedPaths()).toEqual([]);
      const marked = await fs.readFile(join(a.dir, 'a.txt'), 'utf8');
      expect(hasConflictMarkers(marked)).toBe(true);
      expect(marked).toMatch(/^<<<<<<< HEAD$/m);

      await write(a.dir, 'a.txt', 'merged\n');
      await a.git.add(['a.txt']);
      const decided = await a.git.resolvedPaths();
      expect(decided.map((r) => [r.path, r.decision])).toEqual([['a.txt', 'merged']]);
      expect(Object.keys(decided[0]!.stages).sort()).toEqual(['1', '2', '3']);

      await a.git.recreateConflict('a.txt');
      expect(await a.git.resolvedPaths()).toEqual([]);
      expect((await a.git.branchStatus()).entries.filter((e) => e.unmerged)).toHaveLength(1);
      // The labels after an undo are git's generic ones, not the rebase's
      const again = await fs.readFile(join(a.dir, 'a.txt'), 'utf8');
      expect(again).toMatch(/^<<<<<<< ours$/m);
      expect(again).toMatch(/^>>>>>>> theirs$/m);
    } finally {
      await a.cleanup();
    }
  });

  it('reads a kept side as that side, forgets the record at the next stop, and refuses to recreate a removed path', async () => {
    const a = await diverged();
    try {
      expect(await a.git.rebase('theirs')).toBe(false);
      await a.git.resolveSide('a.txt', 'theirs');
      expect((await a.git.resolvedPaths()).map((r) => r.decision)).toEqual(['theirs']);
      await a.git.recreateConflict('a.txt');
      await a.git.resolveSide('a.txt', 'ours');
      expect((await a.git.resolvedPaths()).map((r) => r.decision)).toEqual(['ours']);

      // The second stop: `b.txt` collides and `c.txt` is a modify/delete
      expect(await a.git.rebaseContinue()).toBe(false);
      expect(await a.git.resolvedPaths()).toEqual([]);
      const unmerged = (await a.git.branchStatus()).entries.filter((e) => e.unmerged);
      expect(unmerged.map((e) => e.path).sort()).toEqual(['b.txt', 'c.txt']);

      await a.git.resolveSide('c.txt', 'ours');
      expect((await a.git.resolvedPaths()).map((r) => [r.path, r.decision])).toEqual([
        ['c.txt', 'removed'],
      ]);
      await expect(a.git.recreateConflict('c.txt')).rejects.toThrow(/necessary versions/);
    } finally {
      await a.cleanup();
    }
  });
});
