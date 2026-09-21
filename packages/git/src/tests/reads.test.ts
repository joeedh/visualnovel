import { CHECKPOINT_PREFIX, slugOf } from '../index.js';
import { sh, tempRepo, write } from './helpers.js';

/** Three commits: a text file and a binary, then an edit with trailers, then a rename. */
async function seeded() {
  const repo = await tempRepo();
  const { git, dir } = repo;
  await write(dir, 'a.txt', 'a\nb\n');
  await write(dir, 'bin.dat', Buffer.from([0, 1, 2, 255]));
  const first = (await git.commit({ message: 'First', paths: ['-A'] }))!;
  await write(dir, 'a.txt', 'a\nc\nd\n');
  const second = (await git.commit({
    message : 'Second\n\nBody line.',
    paths   : ['-A'],
    trailers: { 'Vn-Command': 'doc.write', 'Vn-Seq': '3' },
  }))!;
  await sh(dir, ['mv', 'a.txt', 'b.txt']);
  const third = (await git.commit({ message: 'Third', paths: ['-A'] }))!;
  return { ...repo, first, second, third };
}

describe('Git.history', () => {
  it('lists newest first with parents, trailers, a body without them, and touched files', async () => {
    const { git, first, second, third, cleanup } = await seeded();
    try {
      const all = await git.history();
      expect(all.map((e) => e.sha)).toEqual([third, second, first]);
      expect(all[1]).toMatchObject({
        parents : [first],
        author  : 'Test',
        email   : 'test@example.com',
        subject : 'Second',
        body    : 'Body line.',
        trailers: { 'Vn-Command': 'doc.write', 'Vn-Seq': '3' },
        files   : [{ path: 'a.txt', added: 2, removed: 1 }],
      });
      expect(all[1]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(all[2]!.files).toEqual([
        { path: 'a.txt', added: 2, removed: 0 },
        { path: 'bin.dat', added: null, removed: null },
      ]);
      expect(all[0]!.files).toEqual([{ path: 'b.txt', oldPath: 'a.txt', added: 0, removed: 0 }]);
    } finally {
      await cleanup();
    }
  });

  it('pages with before, filters by path and author, and pages a root commit to nothing', async () => {
    const { git, first, second, third, cleanup } = await seeded();
    try {
      expect((await git.history({ limit: 1 })).map((e) => e.sha)).toEqual([third]);
      expect((await git.history({ before: third })).map((e) => e.sha)).toEqual([second, first]);
      expect((await git.history({ before: third, limit: 1 })).map((e) => e.sha)).toEqual([second]);
      expect(await git.history({ before: first })).toEqual([]);
      expect((await git.history({ from: second, limit: 1 })).map((e) => e.sha)).toEqual([second]);
      const byPath = await git.history({ path: 'bin.dat' });
      expect(byPath.map((e) => e.sha)).toEqual([first]);
      // The path picks the commits; each still lists every file it touched
      expect(byPath[0]!.files.map((f) => f.path)).toEqual(['a.txt', 'bin.dat']);
      expect(await git.history({ author: 'nobody' })).toEqual([]);
      expect((await git.history({ author: 'test@example' })).length).toBe(3);
      expect((await git.history({ grep: 'body LINE' })).map((e) => e.sha)).toEqual([second]);
      expect(await git.history({ grep: 'a.b' })).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('reads a blob by the id changes reports, and has no unsent set without an upstream', async () => {
    const { git, second, cleanup } = await seeded();
    try {
      const change = (await git.changes(second)).find((c) => c.path === 'a.txt')!;
      expect((await git.catBlob(change.newBlob!))?.toString()).toBe('a\nc\nd\n');
      expect((await git.catBlob(change.oldBlob!))?.toString()).toBe('a\nb\n');
      expect(await git.catBlob('0'.repeat(40))).toBeNull();
      expect(await git.unsent()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('answers nothing in an unborn repository', async () => {
    const { git, cleanup } = await tempRepo();
    try {
      expect(await git.history()).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('Git.changes, diffPath and blob', () => {
  it('reports a root commit, an edit and a rename with blob ids and counts', async () => {
    const { git, first, second, third, cleanup } = await seeded();
    try {
      const root = await git.changes(first);
      expect(root.map((c) => [c.path, c.status, c.oldBlob, c.added])).toEqual([
        ['a.txt', 'A', null, 2],
        ['bin.dat', 'A', null, null],
      ]);
      expect(root[0]!.newBlob).toMatch(/^[0-9a-f]{40}$/);
      const edit = await git.changes(second);
      expect(edit).toHaveLength(1);
      expect(edit[0]).toMatchObject({ path: 'a.txt', status: 'M', added: 2, removed: 1 });
      expect(edit[0]!.oldBlob).toBe(root[0]!.newBlob);
      const rename = await git.changes(third);
      expect(rename[0]).toMatchObject({ path: 'b.txt', oldPath: 'a.txt', status: 'R' });
    } finally {
      await cleanup();
    }
  });

  it('diffs one path against its parent, the empty tree for a root, or a named commit', async () => {
    const { git, first, second, cleanup } = await seeded();
    try {
      const edit = await git.diffPath(second, 'a.txt');
      expect(edit.binary).toBe(false);
      expect(edit.text).toContain('-b\n+c\n+d');
      const root = await git.diffPath(first, 'a.txt');
      expect(root.text).toContain('+a\n+b');
      expect((await git.diffPath(first, 'bin.dat')).binary).toBe(true);
      const span = await git.diffPath(second, 'a.txt', first);
      expect(span.text).toBe(edit.text);
    } finally {
      await cleanup();
    }
  });

  it('reads a blob as bytes and answers null for a path a commit lacks', async () => {
    const { git, first, third, cleanup } = await seeded();
    try {
      expect(await git.blob(first, 'bin.dat')).toEqual(Buffer.from([0, 1, 2, 255]));
      expect((await git.blob(first, 'a.txt'))!.toString()).toBe('a\nb\n');
      expect(await git.blob(third, 'a.txt')).toBeNull();
      expect(await git.blob(first, 'nope.txt')).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('Git.inProgress and branchStatus', () => {
  it('reports nothing in a quiet repository, with the branch and no upstream', async () => {
    const { git, cleanup } = await seeded();
    try {
      expect(await git.inProgress()).toEqual({ rebase: null, merge: false, revert: false });
      const status = await git.branchStatus();
      expect(status.head).toMatch(/^(master|main)$/);
      expect(status).toMatchObject({ upstream: null, ahead: null, behind: null, entries: [] });
      expect(await git.upstream()).toBeNull();
      expect(await git.remotes()).toEqual([]);
      expect(await git.lastFetch()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('reads a stopped rebase: the branch under the detached head, the position and the conflict', async () => {
    const { git, dir, first, cleanup } = await seeded();
    try {
      const main = await git.branch();
      await sh(dir, ['checkout', '-q', '-b', 'side', first]);
      await write(dir, 'a.txt', 'side\n');
      await git.commit({ message: 'Side edit', paths: ['-A'] });
      const r = await sh(dir, ['rebase', main]);
      expect(r.code).not.toBe(0);
      const state = await git.inProgress();
      expect(state.merge).toBe(false);
      expect(state.rebase).toMatchObject({ branch: 'side', current: 1, total: 1 });
      expect(state.rebase!.onto).toMatch(/^[0-9a-f]{40}$/);
      expect(state.rebase!.stoppedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await git.branch()).toBe('HEAD');
      const status = await git.branchStatus();
      expect(status.head).toBeNull();
      expect(status.entries.some((e) => e.unmerged && e.path === 'a.txt')).toBe(true);
      await sh(dir, ['rebase', '--abort']);
      expect((await git.inProgress()).rebase).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('lists remotes, the upstream, and null counts before the first fetch', async () => {
    const { git, dir, cleanup } = await seeded();
    try {
      await sh(dir, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      await sh(dir, ['remote', 'add', 'backup', '/tmp/backup.git']);
      expect(await git.remotes()).toEqual([
        { name: 'backup', url: '/tmp/backup.git' },
        { name: 'origin', url: 'https://example.com/r.git' },
      ]);
      const main = await git.branch();
      await git.config(`branch.${main}.remote`, 'origin');
      await git.config(`branch.${main}.merge`, `refs/heads/${main}`);
      expect(await git.upstream()).toEqual({ remote: 'origin', branch: main });
      const status = await git.branchStatus();
      expect(status.upstream).toBe(`origin/${main}`);
      expect(status.ahead).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('checkpoints', () => {
  it('creates, lists and deletes annotated tags under the checkpoint prefix', async () => {
    const { git, dir, first, second, cleanup } = await seeded();
    try {
      await git.tag('before-rain', first, 'Before the rain pass\n\nA note.');
      await git.tag('act-two', second, 'Act two');
      await sh(dir, ['tag', 'v1', second]);
      const list = await git.checkpoints();
      expect(list.map((c) => [c.slug, c.name, c.note, c.sha])).toEqual([
        ['act-two', 'Act two', '', second],
        ['before-rain', 'Before the rain pass', 'A note.', first],
      ]);
      expect(list[0]!.taggedAt).toMatch(/^\d{4}-/);
      await git.deleteTag('act-two');
      await git.deleteTag('never-was');
      expect((await git.checkpoints()).map((c) => c.slug)).toEqual(['before-rain']);
      expect((await git.listRefs('refs/tags/')).map((r) => r.ref)).toEqual([
        'refs/tags/v1',
        `${CHECKPOINT_PREFIX}before-rain`,
      ]);
    } finally {
      await cleanup();
    }
  });

  it('produces slugs git accepts as refnames', async () => {
    const { dir, cleanup } = await tempRepo();
    try {
      for (const name of [
        'Before the rain pass',
        'Café ~^:?*[\\ scene',
        '..lead..',
        'x.lock',
        '@{y}',
        '',
      ]) {
        const r = await sh(dir, ['check-ref-format', `${CHECKPOINT_PREFIX}${slugOf(name)}`]);
        expect([name, r.code]).toEqual([name, 0]);
      }
    } finally {
      await cleanup();
    }
  });
});
