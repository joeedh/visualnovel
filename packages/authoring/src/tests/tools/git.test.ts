import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import type { RepoCommit } from '../../tools/git.js';
import { CHUNKS, run, tempProject } from './testkit.js';
import type { ToolContext } from '../../index.js';

/** A project under git with two saves: the scaffold, then an edit to one scene. */
async function repo(): Promise<{ ctx: ToolContext; dir: string; cleanup: () => Promise<void> }> {
  const project = await tempProject();
  const { git } = project.ctx;
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'VN Test');
  await git.config('core.autocrlf', 'false');
  await git.commit({ message: 'New project', paths: ['-A'] });
  await fs.writeFile(
    join(project.dir, 'scenes', 'greet.md'),
    '---\nscene: greet\n---\n\nINT. CLASSROOM - AFTERNOON\n\nA wave.\n\n[[next: ending]]\n',
  );
  await git.commit({
    message : 'Added a wave',
    paths   : ['-A'],
    trailers: { 'Vn-Command': 'story.editLine', 'Vn-Source': 'ui' },
  });
  return project;
}

describe('the git reads', () => {
  it('list the saves with their makers, and show one with its files', async () => {
    const { ctx, cleanup } = await repo();
    try {
      const log = await run('git_log', {}, ctx);
      expect(log.ok).toBe(true);
      const rows = log.data as { subject: string; maker: string; files: number }[];
      expect(rows.map((r) => [r.subject, r.maker, r.files])).toEqual([
        ['Added a wave', 'author', 1],
        ['New project', 'housekeeping', 7],
      ]);
      expect(log.output).toContain('[author] Added a wave (1 file)');

      const onlyAgent = await run('git_log', { who: 'agent' }, ctx);
      expect(onlyAgent.data).toEqual([]);
      const byPath = await run('git_log', { path: 'scenes/greet.md' }, ctx);
      expect((byPath.data as unknown[]).length).toBe(2);

      const shown = await run('git_show', { ref: 'HEAD' }, ctx);
      expect(shown.output).toContain('Vn-Command: story.editLine');
      expect(shown.output).toContain('M scenes/greet.md +2 −0');
      expect(await run('git_show', { ref: '0'.repeat(40) }, ctx)).toMatchObject({ ok: false });
    } finally {
      await cleanup();
    }
  });

  it('diff a save by file, and the disk against the last save without one', async () => {
    const { ctx, dir, cleanup } = await repo();
    try {
      const listed = await run('git_diff', { ref: 'HEAD' }, ctx);
      expect(listed.output).toBe('M scenes/greet.md +2 −0');
      const one = await run('git_diff', { ref: 'HEAD', path: 'scenes/greet.md' }, ctx);
      expect(one.output).toContain('+A wave.');

      expect((await run('git_diff', {}, ctx)).output).toBe('(no changes)');
      await fs.writeFile(join(dir, 'project.yaml'), 'title: Renamed\nstart: arrival\n');
      const dirty = await run('git_diff', {}, ctx);
      expect(dirty.output).toContain(' M project.yaml');
      expect(dirty.output).toContain('+title: Renamed');
      const status = await run('git_status', {}, ctx);
      expect(status.data).toMatchObject({ cause: 'outside', outside: ['project.yaml'] });
      expect(status.output).toContain('Changed on disk and not yet saved:');
    } finally {
      await cleanup();
    }
  });
});

describe('the git writes', () => {
  it('take a save back as a new save the agent signs, and refuse what the rule refuses', async () => {
    const { ctx, dir, cleanup } = await repo();
    try {
      const taken = await run('git_revert', { ref: 'HEAD' }, ctx);
      expect(taken.output).toContain('Took back');
      expect(taken.written).toEqual(['scenes/greet.md']);
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).not.toContain('A wave.');
      const [entry] = await ctx.git.history({ limit: 1 });
      expect(entry).toMatchObject({
        subject : 'Took back: Added a wave',
        trailers: { 'Vn-Source': 'agent' },
      });
      expect((await ctx.git.inProgress()).revert).toBe(false);

      const first = (await ctx.git.history()).at(-1)!.sha;
      expect(await run('git_revert', { ref: first }, ctx)).toMatchObject({
        ok    : false,
        output: expect.stringContaining('first save'),
      });
    } finally {
      await cleanup();
    }
  });

  it('bring a file back only when it would load, and never a key', async () => {
    const { ctx, dir, cleanup } = await repo();
    try {
      const first = (await ctx.git.history()).at(-1)!.sha;
      const back = await run('git_restore', { path: 'scenes/greet.md', ref: first }, ctx);
      expect(back).toMatchObject({ ok: true, written: ['scenes/greet.md'] });
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).not.toContain('A wave.');

      await fs.writeFile(join(dir, 'scenes', 'greet.md'), '---\nscene: greet\n---\nNo heading.\n');
      await ctx.git.commit({ message: 'Broke it', paths: ['-A'] });
      expect(await run('git_restore', { path: 'scenes/greet.md' }, ctx)).toMatchObject({
        ok    : false,
        output: expect.stringContaining('would not load'),
      });
      expect(await run('git_restore', { path: 'keys/openai.txt' }, ctx)).toMatchObject({
        ok    : false,
        output: expect.stringContaining('keys/'),
      });
      expect(await run('git_restore', { path: 'nope.md' }, ctx)).toMatchObject({
        ok    : false,
        output: 'That save has no nope.md.',
      });
    } finally {
      await cleanup();
    }
  });

  /** `repo()` with `wiki/` a repository of its own, recorded in the project as a gitlink. */
  async function withWiki() {
    const project = await repo();
    const wikiDir = join(project.dir, 'wiki');
    await fs.mkdir(wikiDir);
    const wiki = openGit(wikiDir);
    await wiki.init();
    await wiki.config('user.email', 'test@example.com');
    await wiki.config('user.name', 'VN Test');
    await fs.writeFile(join(wikiDir, 'note.md'), 'first\n');
    await wiki.commit({ message: 'wiki', paths: ['-A'] });
    await project.ctx.git.commit({ message: 'record the wiki', paths: ['-A'] });
    return { ...project, wiki };
  }

  const gitlinkOf = (dir: string): string =>
    execFileSync('git', ['ls-tree', 'HEAD', 'wiki'], { cwd: dir }).toString().split(/\s+/)[2]!;

  it('commit each repository its paths belong to, the nested one first', async () => {
    const { ctx, dir, wiki, cleanup } = await withWiki();
    try {
      await fs.writeFile(join(dir, 'scenes', 'greet.md'), CHUNKS.greet!);
      await fs.writeFile(join(dir, 'wiki', 'note.md'), 'second\n');
      const paths = ['scenes/greet.md', 'wiki/note.md'];
      const result = await run('git_commit', { message: 'Both', paths }, ctx);

      expect(result.ok).toBe(true);
      const repos = result.data as RepoCommit[];
      expect(repos.map((r) => [r.root, r.paths])).toEqual([
        [wiki.root, ['wiki/note.md']],
        [dir, ['scenes/greet.md']],
      ]);
      const [inWiki, inProject] = repos.map((r) => r.sha!.slice(0, 7));
      expect(result.output).toBe(`Committed ${inWiki} (wiki), ${inProject} (project): Both`);
      expect(gitlinkOf(dir)).toBe(await wiki.head());
      expect(await ctx.git.isDirty()).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('bump the gitlink alone when only the nested repository was written', async () => {
    const { ctx, dir, wiki, cleanup } = await withWiki();
    try {
      await fs.writeFile(join(dir, 'wiki', 'note.md'), 'second\n');
      const result = await run('git_commit', { message: 'Wiki', paths: ['wiki/note.md'] }, ctx);

      const repos = result.data as RepoCommit[];
      expect(repos.map((r) => [r.root, r.paths, r.sha !== null])).toEqual([
        [wiki.root, ['wiki/note.md'], true],
        [dir, [], true],
      ]);
      expect(gitlinkOf(dir)).toBe(await wiki.head());
      const [bump] = await ctx.git.history({ limit: 1 });
      expect(bump!.files.map((f) => f.path)).toEqual(['wiki']);
    } finally {
      await cleanup();
    }
  });

  it('name a checkpoint on the latest save, and refuse a name already taken', async () => {
    const { ctx, cleanup } = await repo();
    try {
      const made = await run('git_checkpoint', { name: 'Before act two', note: 'Safe.' }, ctx);
      expect(made).toMatchObject({ ok: true, data: { slug: 'before-act-two' } });
      const [checkpoint] = await ctx.git.checkpoints();
      expect(checkpoint).toMatchObject({ name: 'Before act two', note: 'Safe.' });
      expect(await run('git_checkpoint', { name: 'before act TWO' }, ctx)).toMatchObject({
        ok    : false,
        output: expect.stringContaining('already exists'),
      });
      const log = await run('git_log', {}, ctx);
      expect((log.data as { checkpoints: string[] }[])[0]!.checkpoints).toEqual(['Before act two']);
    } finally {
      await cleanup();
    }
  });
});
