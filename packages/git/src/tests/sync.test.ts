import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  finishRebase,
  openGit,
  pairRewrites,
  parseCommitKeys,
  remoteNameProblem,
  remoteSentence,
  remoteUrlProblem,
  resolveRewritten,
  UNIT,
  type CommitKey,
  type Git,
} from '../index.js';
import { hasConflictMarkers } from '@vn/util';
import { sh, tempRepo, write } from './helpers.js';

const key = (sha: string, k: string): CommitKey => ({ sha: sha.repeat(40), key: k });

describe('the remote rules', () => {
  it('refuse a name git would refuse, an empty one, and one already taken', () => {
    expect(remoteNameProblem('origin', [])).toBeUndefined();
    expect(remoteNameProblem('nas-backup', ['origin'])).toBeUndefined();
    expect(remoteNameProblem('', [])).toBe('A shared copy needs a name.');
    expect(remoteNameProblem('origin', ['origin'])).toContain('already exists');
    for (const bad of ['two words', 'a..b', '-lead', 'x.lock', 'a/b', 'q?', 'tail.', '@{x']) {
      expect(remoteNameProblem(bad, [])).toContain('cannot name a shared copy');
    }
  });

  it('accept the three address forms and refuse the rest', () => {
    for (const ok of [
      'https://github.com/mara/rooftop.git',
      'git@github.com:mara/rooftop.git',
      'ssh://git@host/repo.git',
      '/srv/git/rooftop.git',
      'D:\\backup\\rooftop.git',
      'E:/backup/rooftop',
      '\\\\nas\\stories\\rooftop.git',
    ]) {
      expect(remoteUrlProblem(ok)).toBeUndefined();
    }
    expect(remoteUrlProblem('')).toBe('A shared copy needs an address.');
    expect(remoteUrlProblem('http://insecure.example/x.git')).toContain('https://');
    expect(remoteUrlProblem('rooftop.git')).toContain('folder on this machine');
    expect(remoteUrlProblem('https://has a space')).toContain('https://');
  });
});

describe('pairRewrites', () => {
  it('pairs by key across the lists and records a dropped save with no new sha', () => {
    const before = [key('a', 'k1'), key('b', 'k2'), key('c', 'k3')];
    const after = [key('d', 'k1'), key('e', 'k3')];
    expect(pairRewrites(before, after)).toEqual([
      { from: 'a'.repeat(40), to: 'd'.repeat(40) },
      { from: 'b'.repeat(40), to: null },
      { from: 'c'.repeat(40), to: 'e'.repeat(40) },
    ]);
  });

  it('pairs two saves with one key in order, and skips a save the rebase left alone', () => {
    const before = [key('a', 'k'), key('b', 'k')];
    expect(pairRewrites(before, [key('c', 'k'), key('d', 'k')])).toEqual([
      { from: 'a'.repeat(40), to: 'c'.repeat(40) },
      { from: 'b'.repeat(40), to: 'd'.repeat(40) },
    ]);
    expect(pairRewrites(before, before)).toEqual([]);
  });

  it('parses the log format into keys that ignore the sha and keep the message', () => {
    const line = (sha: string, msg: string) =>
      `\x1e${sha}${UNIT}Mara${UNIT}m@x${UNIT}2026-09-21T10:00:00+00:00${UNIT}${msg}\n`;
    const keys = parseCommitKeys(
      line('a'.repeat(40), 'One\n\nVn-Seq: 3\n') + line('b'.repeat(40), 'Two\n'),
    );
    expect(keys.map((k) => k.sha[0])).toEqual(['a', 'b']);
    expect(keys[0]!.key).not.toBe(keys[1]!.key);
    const same = parseCommitKeys(line('c'.repeat(40), 'One\n\nVn-Seq: 3\n'));
    expect(same[0]!.key).toBe(keys[0]!.key);
    expect(parseCommitKeys('')).toEqual([]);
  });

  it('resolves a sha through the tables newest first', () => {
    const newest = [{ from: 'b', to: 'c' }];
    const older = [
      { from: 'a', to: 'b' },
      { from: 'x', to: null },
    ];
    expect(resolveRewritten('a', [newest, older])).toBe('b');
    expect(resolveRewritten('b', [newest, older])).toBe('c');
    expect(resolveRewritten('x', [newest, older])).toBeNull();
    expect(resolveRewritten('q', [newest, older])).toBe('q');
  });
});

describe('the small helpers', () => {
  it('spot conflict markers and trim git’s sentence', () => {
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> mine\n')).toBe(true);
    expect(hasConflictMarkers('<<<<<<<\n')).toBe(true);
    expect(hasConflictMarkers('a <<<<<<< b\n')).toBe(false);
    expect(remoteSentence('git push failed: fatal: could not read Username\nerror: x')).toBe(
      'could not read Username x',
    );
  });
});

// The app appends to its logs while a rebase runs, and git will not replay a commit over a file
// with unstaged edits. Both stops are absorbed rather than shown as a conflict.
describe('a rebase over files the app keeps writing', () => {
  /** `main` and `theirs` diverge from a base; each of the author's two saves appends to the log. */
  async function diverged(): Promise<{ git: Git; dir: string; cleanup: () => Promise<void> }> {
    const a = await tempRepo();
    await write(a.dir, '.gitattributes', 'log.jsonl merge=union\n');
    await write(a.dir, 'a.txt', 'a\n');
    await write(a.dir, 'log.jsonl', '{"seq":1}\n');
    await a.git.commit({ message: 'Base', paths: ['-A'] });
    const base = (await a.git.head())!;
    await write(a.dir, 'a.txt', 'theirs\n');
    await a.git.updateRef(
      'refs/heads/theirs',
      await a.git.commitTree(await a.git.writeTree(), { message: 'Theirs', parents: [base] }),
    );
    await write(a.dir, 'a.txt', 'mine\n');
    await write(a.dir, 'log.jsonl', '{"seq":1}\n{"seq":2}\n');
    await a.git.commit({ message: 'Mine', paths: ['-A'] });
    await write(a.dir, 'log.jsonl', '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    await a.git.commit({ message: 'Read something', paths: ['-A'] });
    return a;
  }

  it('folds an edit made after the resolution was staged into the replayed save', async () => {
    const a = await diverged();
    try {
      expect(await a.git.rebase('theirs')).toBe(false);
      await a.git.resolveSide('a.txt', 'theirs');
      // Written after the staging and before the continue, as a notification is
      await write(a.dir, 'log.jsonl', '{"seq":1}\n{"seq":2}\n{"seq":9}\n');
      expect(await a.git.rebaseContinue()).toBe(true);
      expect((await a.git.log()).map((c) => c.subject)).toEqual([
        'Read something',
        'Mine',
        'Theirs',
        'Base',
      ]);
      expect((await a.git.status()).dirty).toBe(false);
      expect(await a.git.show('HEAD:log.jsonl')).toContain('{"seq":9}');
      expect(await a.git.show('HEAD:log.jsonl')).toContain('{"seq":3}');
    } finally {
      await a.cleanup();
    }
  });

  it('folds an edit git refused to replay over into the save before it, and continues', async () => {
    const a = await diverged();
    try {
      expect(await a.git.rebase('theirs')).toBe(false);
      await a.git.resolveSide('a.txt', 'theirs');
      // A hook stands in for the app: the log gains a line while `Mine` is being committed, so
      // `Read something` is refused over it
      await write(
        a.dir,
        '.git/hooks/post-commit',
        '#!/bin/sh\nlog="$(git rev-parse --show-toplevel)/log.jsonl"\n' +
          'grep -q \'"seq":9\' "$log" || printf \'{"seq":9}\\n\' >> "$log"\n',
      );
      expect(await a.git.rebaseContinue()).toBe(true);
      expect((await a.git.log()).map((c) => c.subject)).toEqual([
        'Read something',
        'Mine',
        'Theirs',
        'Base',
      ]);
      expect(await a.git.show('HEAD:log.jsonl')).toContain('{"seq":3}');
      // Folded into `Mine`, the save replayed before the refused one
      expect(await a.git.show('HEAD~1:log.jsonl')).toBe('{"seq":1}\n{"seq":2}\n{"seq":9}\n');
    } finally {
      await a.cleanup();
    }
  });
});

describe('finishRebase', () => {
  async function bare(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-bare-'));
    await sh(dir, ['init', '--bare', '-q']);
    return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }

  async function clone(
    remote: string,
  ): Promise<{ git: Git; dir: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-clone-'));
    await sh(dir, ['clone', '-q', '-c', 'core.autocrlf=false', remote, '.']);
    const git = openGit(dir);
    await git.config('user.email', 'other@example.com');
    await git.config('user.name', 'Other');
    return { git, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }

  it('pairs the replayed saves, drops the one the copy already had, and moves a checkpoint', async () => {
    const remote = await bare();
    const a = await tempRepo();
    let b: Awaited<ReturnType<typeof clone>> | undefined;
    try {
      await write(a.dir, 'a.txt', 'a\n');
      await a.git.commit({ message: 'First', paths: ['-A'] });
      await a.git.remoteAdd('origin', remote.dir);
      const branch = await a.git.branch();
      await a.git.push('origin', branch);
      await a.git.setUpstream('origin', branch);

      // The collaborator makes one save of their own and one identical to a save of the author's
      b = await clone(remote.dir);
      await write(b.dir, 'b.txt', 'theirs\n');
      await b.git.commit({ message: 'Their save', paths: ['-A'] });
      await write(b.dir, 'shared.txt', 'same\n');
      await b.git.commit({ message: 'Shared', paths: ['-A'] });
      await b.git.push('origin', branch);

      await write(a.dir, 'shared.txt', 'same\n');
      const dropped = (await a.git.commit({ message: 'Shared', paths: ['-A'] }))!;
      await write(a.dir, 'a.txt', 'a\nmine\n');
      const mine = (await a.git.commit({ message: 'Mine', paths: ['-A'] }))!;
      await a.git.tag('mark', mine, 'Mark\n\nA note.');

      const onto = (await a.git.fetch('origin'), await a.git.resolve(`origin/${branch}`))!;
      const origHead = (await a.git.head())!;
      expect(await a.git.rebase(`origin/${branch}`)).toBe(true);
      const done = await finishRebase(a.git, onto, origHead);
      expect(done.replayed).toBe(1);
      const newMine = (await a.git.head())!;
      expect(newMine).not.toBe(mine);
      expect(done.rewrote).toEqual([
        { from: mine, to: newMine },
        { from: dropped, to: null },
      ]);
      const [mark] = await a.git.checkpoints();
      expect(mark).toMatchObject({ slug: 'mark', name: 'Mark', note: 'A note.', sha: newMine });
      expect(await a.git.aheadBehind(`origin/${branch}`)).toEqual({ ahead: 1, behind: 0 });
      expect(await a.git.aheadBehind('origin/nowhere')).toBeNull();
    } finally {
      await b?.cleanup();
      await a.cleanup();
      await remote.cleanup();
    }
  });

  it('reads the original head off a stopped rebase, and trackRemote needs no tracking ref', async () => {
    const remote = await bare();
    const a = await tempRepo();
    let b: Awaited<ReturnType<typeof clone>> | undefined;
    try {
      await write(a.dir, 'a.txt', 'a\n');
      await a.git.commit({ message: 'First', paths: ['-A'] });
      await a.git.remoteAdd('origin', remote.dir);
      const branch = await a.git.branch();
      await a.git.trackRemote(branch, 'origin');
      expect(await a.git.upstream()).toEqual({ remote: 'origin', branch });
      await a.git.push('origin', branch);

      b = await clone(remote.dir);
      await write(b.dir, 'a.txt', 'theirs\n');
      await b.git.commit({ message: 'Their save', paths: ['-A'] });
      await b.git.push('origin', branch);

      await write(a.dir, 'a.txt', 'mine\n');
      const mine = (await a.git.commit({ message: 'Mine', paths: ['-A'] }))!;
      await a.git.fetch('origin');
      expect(await a.git.rebase(`origin/${branch}`)).toBe(false);
      const state = await a.git.inProgress();
      expect(state.rebase?.origHead).toBe(mine);
      expect(state.rebase?.onto).toBe(await a.git.resolve(`origin/${branch}`));
      await a.git.rebaseAbort();
    } finally {
      await b?.cleanup();
      await a.cleanup();
      await remote.cleanup();
    }
  });
});
