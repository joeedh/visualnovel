import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { hasConflictMarkers } from '@vn/util';
import { SYNC_PART_WAY } from '../../tools/git.js';
import { run, tempProject } from './testkit.js';
import type { ToolContext } from '../../index.js';

const GREET = (line: string): string =>
  `---\nscene: greet\n---\n\nINT. CLASSROOM - AFTERNOON\n\n${line}\n\n[[next: ending]]\n`;

/**
 * A project whose `main` and `theirs` both changed one line of `scenes/greet.md` and the same
 * key of `project.yaml`, with `main` rebased onto `theirs` and stopped on both.
 */
async function stopped(): Promise<{ ctx: ToolContext; dir: string; cleanup: () => Promise<void> }> {
  const project = await tempProject();
  const { git } = project.ctx;
  project.ctx.seen = new Map();
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'VN Test');
  await git.config('core.autocrlf', 'false');
  await fs.writeFile(join(project.dir, 'scenes', 'greet.md'), GREET('A wave.'));
  await git.commit({ message: 'Base', paths: ['-A'] });
  const base = (await git.head())!;
  await fs.writeFile(join(project.dir, 'scenes', 'greet.md'), GREET('A deep bow.'));
  await fs.writeFile(join(project.dir, 'project.yaml'), 'title: Theirs\nstart: arrival\n');
  await git.add(['-A']);
  await git.updateRef(
    'refs/heads/theirs',
    await git.commitTree(await git.writeTree(), { message: 'Theirs', parents: [base] }),
  );
  await git.restore('.', 'HEAD');
  await fs.writeFile(join(project.dir, 'scenes', 'greet.md'), GREET('A curtsy.'));
  await fs.writeFile(join(project.dir, 'project.yaml'), 'title: Mine\nstart: arrival\n');
  await git.commit({ message: 'Mine', paths: ['-A'] });
  expect(await git.rebase('theirs')).toBe(false);
  return project;
}

describe('resolve_conflict', () => {
  it('merges a scene it has read, stages it, and refuses one it has not', async () => {
    const { ctx, dir, cleanup } = await stopped();
    try {
      const marked = await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8');
      expect(hasConflictMarkers(marked)).toBe(true);
      const merged = GREET('A deep bow, then a curtsy.');

      const unread = await run('resolve_conflict', { path: 'scenes/greet.md', text: merged }, ctx);
      expect(unread.ok).toBe(false);
      expect(unread.output).toMatch(/has not been read this conversation/);

      expect((await run('read_file', { path: 'scenes/greet.md' }, ctx)).output).toBe(marked);
      const done = await run('resolve_conflict', { path: 'scenes/greet.md', text: merged }, ctx);
      expect(done).toMatchObject({ ok: true, written: ['scenes/greet.md'] });
      expect(done.output).toBe(
        'Decided scenes/greet.md; the merged file is staged for the save being replayed.',
      );
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(merged);
      const status = await ctx.git.branchStatus();
      expect(status.entries.find((e) => e.path === 'scenes/greet.md')?.unmerged).toBe(false);
      expect(await ctx.git.resolvedPaths()).toMatchObject([
        { path: 'scenes/greet.md', decision: 'merged' },
      ]);

      // Decided: no longer waiting, so a second write is refused rather than repeated
      const again = await run('resolve_conflict', { path: 'scenes/greet.md', text: merged }, ctx);
      expect(again.output).toBe('scenes/greet.md is not waiting on a decision.');
    } finally {
      await cleanup();
    }
  });

  it('holds the merge to the same check as the pane, and reads the file as it is now', async () => {
    const { ctx, dir, cleanup } = await stopped();
    try {
      await run('read_file', { path: 'scenes/greet.md' }, ctx);
      const wrong = GREET('[[line: L1]]\nA bow.\n\n[[line: L1]]\nA curtsy.');
      const refused = await run('resolve_conflict', { path: 'scenes/greet.md', text: wrong }, ctx);
      expect(refused.ok).toBe(false);
      expect(refused.output).toMatch(/^scenes\/greet\.md would not load: /);

      await run('read_file', { path: 'project.yaml' }, ctx);
      const marked = await fs.readFile(join(dir, 'project.yaml'), 'utf8');
      const stillMarked = await run(
        'resolve_conflict',
        { path: 'project.yaml', text: marked },
        ctx,
      );
      expect(stillMarked.output).toBe('project.yaml still holds conflict markers.');
      const yaml = await run(
        'resolve_conflict',
        { path: 'project.yaml', text: 'title: Ours together\nstart: arrival\n' },
        ctx,
      );
      expect(yaml.ok).toBe(true);

      // The scene changed under the conversation since it was read, and is still marked
      const scene = join(dir, 'scenes', 'greet.md');
      await fs.writeFile(scene, (await fs.readFile(scene, 'utf8')).replace('bow', 'nod'));
      const stale = await run(
        'resolve_conflict',
        { path: 'scenes/greet.md', text: GREET('A bow and a curtsy.') },
        ctx,
      );
      expect(stale.output).toMatch(/changed since you read it/);
    } finally {
      await cleanup();
    }
  });

  it('refuses an ordinary write on a file the sync is waiting on', async () => {
    const { ctx, cleanup } = await stopped();
    try {
      const refusal =
        'project.yaml is waiting on a merge decision — resolve_conflict decides it, with the ' +
        'whole file as it should read. An ordinary write would leave the sync still waiting on it.';
      const wrote = await run(
        'write_file',
        { path: 'project.yaml', content: 'title: Mine\nstart: arrival\n' },
        ctx,
      );
      expect(wrote).toEqual({ ok: false, output: refusal });

      await run('read_file', { path: 'project.yaml' }, ctx);
      const edited = await run(
        'edit_file',
        { path: 'project.yaml', edits: [{ old: 'start: arrival', new: 'start: greet' }] },
        ctx,
      );
      expect(edited).toEqual({ ok: false, output: refusal });

      // A file the sync is not waiting on is written as usual, rebase or no rebase
      expect(
        await run('write_file', { path: 'wiki/notes.md', content: 'Notes.\n' }, ctx),
      ).toMatchObject({ ok: true });
    } finally {
      await cleanup();
    }
  });

  it('is refused with no sync stopped, as are a commit and a restore while one is', async () => {
    const { ctx, cleanup } = await stopped();
    try {
      const commit = await run('git_commit', { message: 'Merged' }, ctx);
      expect(commit).toEqual({ ok: false, output: SYNC_PART_WAY });
      const restore = await run('git_restore', { path: 'scenes/greet.md' }, ctx);
      expect(restore).toEqual({ ok: false, output: SYNC_PART_WAY });

      await ctx.git.rebaseAbort();
      expect((await ctx.git.inProgress()).rebase).toBeNull();
      const idle = await run(
        'resolve_conflict',
        { path: 'scenes/greet.md', text: GREET('A bow.') },
        ctx,
      );
      expect(idle.output).toBe('No sync is waiting on a decision.');
    } finally {
      await cleanup();
    }
  });
});
