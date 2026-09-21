import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InProgressError, openGit, operationOf, type Git } from '../index.js';
import { sh, tempRepo, write } from './helpers.js';

/** A bare repository to push to and pull from, at a plain filesystem path. */
async function bareRemote(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-bare-'));
  await sh(dir, ['init', '--bare', '-q']);
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A repository with one commit, pushed to `remote` as the branch's upstream. */
async function connected(remote: string) {
  const repo = await tempRepo();
  const { git, dir } = repo;
  await write(dir, 'a.txt', 'a\n');
  await write(dir, 'layout.json', '{"v":1}\n');
  await git.commit({ message: 'First', paths: ['-A'] });
  await git.remoteAdd('origin', remote);
  const branch = await git.branch();
  await git.push('origin', branch);
  await git.setUpstream('origin', branch);
  return { ...repo, branch };
}

/** Clones the bare repository into a second working copy with its own identity. */
async function cloneOf(
  remote: string,
): Promise<{ git: Git; dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-clone-'));
  // Before the checkout, or a global autocrlf would leave every file modified in the clone
  await sh(dir, ['clone', '-q', '-c', 'core.autocrlf=false', remote, '.']);
  const git = openGit(dir);
  await git.config('user.email', 'other@example.com');
  await git.config('user.name', 'Other');
  return { git, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

describe('remotes', () => {
  it('adds, renames the URL of, and removes a remote, and sets the upstream', async () => {
    const { git, cleanup } = await tempRepo();
    try {
      await git.remoteAdd('origin', 'https://example.com/a.git');
      await git.remoteAdd('backup', '/tmp/b.git');
      await git.remoteSetUrl('origin', 'https://example.com/c.git');
      expect(await git.remotes()).toEqual([
        { name: 'backup', url: '/tmp/b.git' },
        { name: 'origin', url: 'https://example.com/c.git' },
      ]);
      await git.remoteRemove('backup');
      expect((await git.remotes()).map((r) => r.name)).toEqual(['origin']);
      await expect(git.remoteAdd('origin', 'x')).rejects.toThrow(/already exists/);
    } finally {
      await cleanup();
    }
  });
});

describe('fetch, push and rebase', () => {
  it('pushes, fetches, and counts ahead and behind against the upstream', async () => {
    const remote = await bareRemote();
    const a = await connected(remote.dir);
    try {
      expect(await aheadBehind(a.git)).toEqual([0, 0]);
      await write(a.dir, 'a.txt', 'a\nb\n');
      await a.git.commit({ message: 'Second', paths: ['-A'] });
      expect(await aheadBehind(a.git)).toEqual([1, 0]);
      await a.git.push('origin', a.branch);
      expect(await aheadBehind(a.git)).toEqual([0, 0]);
      expect(await a.git.lastFetch()).toBeNull();
      await a.git.fetch('origin');
      expect(await a.git.lastFetch()).toMatch(/^\d{4}-/);
    } finally {
      await a.cleanup();
      await remote.cleanup();
    }
  });

  it('pushes checkpoint tags along with the branch', async () => {
    const remote = await bareRemote();
    const a = await connected(remote.dir);
    try {
      const head = (await a.git.head())!;
      await a.git.tag('start', head, 'Start');
      await write(a.dir, 'a.txt', 'a\nb\n');
      await a.git.commit({ message: 'Second', paths: ['-A'] });
      await a.git.push('origin', a.branch);
      const listed = await sh(remote.dir, ['tag', '-l']);
      expect(listed.out.trim()).toBe('vn/checkpoint/start');
    } finally {
      await a.cleanup();
      await remote.cleanup();
    }
  });

  it('rebases cleanly when the collaborator touched other files', async () => {
    const remote = await bareRemote();
    const a = await connected(remote.dir);
    const b = await cloneOf(remote.dir);
    try {
      await write(b.dir, 'b.txt', 'theirs\n');
      await b.git.commit({ message: 'Their save', paths: ['-A'] });
      await b.git.push('origin', a.branch);

      await write(a.dir, 'a.txt', 'a\nmine\n');
      const mine = (await a.git.commit({ message: 'My save', paths: ['-A'] }))!;
      await a.git.fetch('origin');
      expect(await aheadBehind(a.git)).toEqual([1, 1]);
      expect(await a.git.rebase(`origin/${a.branch}`)).toBe(true);
      expect(await aheadBehind(a.git)).toEqual([1, 0]);
      const history = await a.git.history();
      expect(history.map((e) => e.subject)).toEqual(['My save', 'Their save', 'First']);
      expect(history[0]!.sha).not.toBe(mine);
      expect(await a.git.inProgress()).toEqual({ rebase: null, merge: false, revert: false });
    } finally {
      await b.cleanup();
      await a.cleanup();
      await remote.cleanup();
    }
  });

  it('stops on a conflict, refuses a commit there, resolves a side, and continues', async () => {
    const remote = await bareRemote();
    const a = await connected(remote.dir);
    const b = await cloneOf(remote.dir);
    try {
      await write(b.dir, 'a.txt', 'theirs\n');
      await b.git.commit({ message: 'Their save', paths: ['-A'] });
      await b.git.push('origin', a.branch);

      await write(a.dir, 'a.txt', 'mine\n');
      await a.git.commit({ message: 'My save', paths: ['-A'] });
      await a.git.fetch('origin');
      expect(await a.git.rebase(`origin/${a.branch}`)).toBe(false);

      const state = await a.git.inProgress();
      expect(operationOf(state)).toBe('rebase');
      expect(state.rebase).toMatchObject({ branch: a.branch, current: 1, total: 1 });
      await expect(a.git.commit({ message: 'Nope', paths: ['-A'] })).rejects.toBeInstanceOf(
        InProgressError,
      );
      expect(await fs.readFile(join(a.dir, 'a.txt'), 'utf8')).toContain('<<<<<<<');

      // `theirs` during a rebase is the commit being replayed: the author's own
      await a.git.resolveSide('a.txt', 'theirs');
      expect(await fs.readFile(join(a.dir, 'a.txt'), 'utf8')).toBe('mine\n');
      expect(await a.git.rebaseContinue()).toBe(true);
      expect((await a.git.history()).map((e) => e.subject)).toEqual([
        'My save',
        'Their save',
        'First',
      ]);
      expect(await a.git.branch()).toBe(a.branch);
    } finally {
      await b.cleanup();
      await a.cleanup();
      await remote.cleanup();
    }
  });

  it('resolves a path one side deleted by deleting it, and aborts back to the start', async () => {
    const remote = await bareRemote();
    const a = await connected(remote.dir);
    const b = await cloneOf(remote.dir);
    try {
      await sh(b.dir, ['rm', '-q', 'a.txt']);
      await b.git.commit({ message: 'Their delete', paths: ['-A'] });
      await b.git.push('origin', a.branch);

      await write(a.dir, 'a.txt', 'mine\n');
      const mine = (await a.git.commit({ message: 'My save', paths: ['-A'] }))!;
      await a.git.fetch('origin');
      expect(await a.git.rebase(`origin/${a.branch}`)).toBe(false);
      await a.git.resolveSide('a.txt', 'ours');
      expect(
        await fs.stat(join(a.dir, 'a.txt')).then(
          () => true,
          () => false,
        ),
      ).toBe(false);

      await a.git.rebaseAbort();
      expect(await a.git.head()).toBe(mine);
      expect(await fs.readFile(join(a.dir, 'a.txt'), 'utf8')).toBe('mine\n');
      expect((await a.git.inProgress()).rebase).toBeNull();
    } finally {
      await b.cleanup();
      await a.cleanup();
      await remote.cleanup();
    }
  });
});

describe('revertDryRun', () => {
  it('says a revert is clean, or names the files that would conflict, and leaves nothing behind', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      await write(dir, 'a.txt', 'one\n');
      await git.commit({ message: 'First', paths: ['-A'] });
      await write(dir, 'a.txt', 'two\n');
      const second = (await git.commit({ message: 'Second', paths: ['-A'] }))!;
      expect(await git.revertDryRun(second)).toEqual({ clean: true, conflicts: [] });
      expect(await git.isDirty()).toBe(false);
      expect((await git.inProgress()).revert).toBe(false);

      await write(dir, 'a.txt', 'three\n');
      await git.commit({ message: 'Third', paths: ['-A'] });
      expect(await git.revertDryRun(second)).toEqual({ clean: false, conflicts: ['a.txt'] });
      expect(await git.isDirty()).toBe(false);
      expect(await fs.readFile(join(dir, 'a.txt'), 'utf8')).toBe('three\n');
    } finally {
      await cleanup();
    }
  });
});

/** `[ahead, behind]` against the branch's upstream. */
async function aheadBehind(git: Git): Promise<[number | null, number | null]> {
  const s = await git.branchStatus();
  return [s.ahead, s.behind];
}
