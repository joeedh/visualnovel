import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit, type Git } from '@vn/git';
import { defineFor, type CommandRecord } from '../command.js';
import { Committer } from '../commit.js';
import { prop } from '../props.js';
import { CommandRegistry } from '../registry.js';
import { CommandStack } from '../stack.js';

/** A repo with a deterministic identity (no global config bleed). */
async function initRepo(dir: string): Promise<Git> {
  const git = openGit(dir);
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'Test');
  await git.config('core.autocrlf', 'false');
  return git;
}

async function tempProject() {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-commit-')));
  const git = await initRepo(dir);
  await fs.writeFile(join(dir, 'doc.md'), 'authored\n');
  await git.commit({ message: 'init', paths: ['.'] });
  return { dir, git, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function record(over: Partial<CommandRecord> = {}): CommandRecord {
  return {
    seq: 7,
    id: 'story.moveLine',
    props: { line: 'L4' },
    invocation: "story.moveLine(line='L4')",
    source: 'ui',
    mutating: true,
    gitHead: null,
    gitDirty: true,
    startedAt: '2026-07-25T00:00:00.000Z',
    finishedAt: '2026-07-25T00:00:00.000Z',
    status: 'ok',
    message: 'Moved L4 into scene two.',
    ...over,
  };
}

describe('Committer', () => {
  it("commits the whole worktree under the record's message, with provenance trailers", async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      const committer = new Committer({ repos: () => [git] });
      // Untracked, modified, deleted — none of it declared by `written`, all of it committed.
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      await fs.writeFile(join(dir, 'new.md'), 'a new scene\n');

      const commits = await committer.commit(record({ written: ['doc.md'] }));
      expect(commits).toHaveLength(1);
      expect(commits[0]!.repo).toBe(dir);

      expect(await git.isDirty()).toBe(false);
      const [head] = await git.log(1);
      expect(head!.subject).toBe('Moved L4 into scene two');

      const body = await git.show(commits[0]!.sha);
      expect(body).toContain('Vn-Command: story.moveLine');
      expect(body).toContain('Vn-Seq: 7');
      expect(body).toContain("Vn-Invocation: story.moveLine(line='L4')");
      expect(body).toContain('Vn-Source: ui');
      expect(body).toContain('new.md');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('keeps a prose message out of the commit body, and prefers the record’s own subject', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      const committer = new Committer({ repos: () => [git] });
      const prose =
        'Fixed and committed.\n\n**The cause:** a shot’s description named the wrong plate.';

      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      const first = await committer.commit(record({ message: prose }));
      expect((await git.log(1))[0]!.subject).toBe('Fixed and committed');
      expect(await git.show(first[0]!.sha)).not.toContain('The cause:');

      await fs.writeFile(join(dir, 'doc.md'), 'edited again\n');
      await committer.commit(record({ message: prose, subject: 'Agent turn: fix the plate' }));
      expect((await git.log(1))[0]!.subject).toBe('Agent turn: fix the plate');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('produces no commit when the act left nothing on disk', async () => {
    const { git, cleanup } = await tempProject();
    try {
      const committer = new Committer({ repos: () => [git] });
      expect(await committer.commit(record())).toEqual([]);
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('commits each repo that had something, and skips directories that are not repos', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      const bare = join(dir, 'not-a-repo');
      await fs.mkdir(bare);
      const committer = new Committer({ repos: () => [git, openGit(bare)] });

      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      const commits = await committer.commit(record());
      expect(commits.map((c) => c.repo)).toEqual([dir]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('marks a checkpoint as its own kind of event', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      await fs.writeFile(join(dir, 'doc.md'), 'edited outside the app\n');
      const commits = await new Committer({ repos: () => [git] }).checkpoint(
        'Changes made outside the app',
      );
      expect(commits).toHaveLength(1);
      const body = await git.show(commits[0]!.sha);
      expect(body).toContain('Changes made outside the app');
      expect(body).toContain('Vn-Checkpoint: true');
      expect(body).not.toContain('Vn-Command:');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('keeps the subject to one line, and falls back when there is no message', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      const committer = new Committer({ repos: () => [git] });
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      await committer.commit(record({ message: `${'a very long summary '.repeat(8)}.` }));
      await fs.writeFile(join(dir, 'doc.md'), 'edited again\n');
      await committer.commit(record({ message: '   ' }));

      const [blank, long] = await git.log(2);
      expect(long!.subject).toHaveLength(72);
      expect(long!.subject.endsWith('…')).toBe(true);
      expect(blank!.subject).toBe("story.moveLine(line='L4')");
    } finally {
      await cleanup();
    }
  }, 20_000);
});

interface Host {
  writes: number;
}

const define = defineFor<Host>();

/** A stack over a real repo whose one command writes a file. */
async function stackSetup(opts: { committer: boolean }) {
  const { dir, git, cleanup } = await tempProject();
  const registry = new CommandRegistry<Host>();
  registry.registerAll([
    define({
      id: 'demo.edit',
      title: 'Edit',
      description: 'Write a document.',
      mutating: true,
      props: { to: prop.string('the new text') },
      async run(props, ctx) {
        ctx.host.writes++;
        await fs.writeFile(join(dir, 'doc.md'), `${props.to}\n`);
        return { message: `set ${props.to}` };
      },
    }),
    define({
      id: 'demo.agent',
      title: 'Agent',
      description: 'Writes and commits on its own.',
      mutating: true,
      commitsItself: true,
      props: {},
      async run() {
        await fs.writeFile(join(dir, 'doc.md'), 'by the agent\n');
        return { message: 'ran a plan' };
      },
    }),
    define({
      id: 'demo.look',
      title: 'Look',
      description: 'Reads and writes nothing.',
      mutating: false,
      props: {},
      run: () => Promise.resolve({ message: 'looked' }),
    }),
  ]);
  const stack = new CommandStack<Host>({
    registry,
    context: { root: dir, git, host: { writes: 0 }, log: () => {} },
    ...(opts.committer ? { committer: new Committer({ repos: () => [git] }) } : {}),
  });
  return { dir, git, stack, cleanup };
}

describe('commit-on-save through the stack', () => {
  it('commits a mutating command and records the sha', async () => {
    const { git, stack, cleanup } = await stackSetup({ committer: true });
    try {
      const outcome = await stack.exec('demo.edit', { to: 'edited' }, 'ui');
      expect(outcome.ok).toBe(true);
      const commits = outcome.ok ? outcome.record.commits : undefined;
      expect(commits).toHaveLength(1);
      expect((await git.log(1))[0]!.hash).toBe(commits![0]!.sha);
      expect(await git.isDirty()).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('leaves a read-only command, a failed one, and a self-committing one uncommitted', async () => {
    const { dir, git, stack, cleanup } = await stackSetup({ committer: true });
    try {
      await stack.exec('demo.look', {}, 'ui');
      // Refused before it runs, so nothing was written and nothing is there to commit.
      await stack.exec('demo.edit', { nope: 1 }, 'ui');
      const agent = await stack.exec('demo.agent', {}, 'ui');

      expect(agent.ok && agent.record.commits).toBeUndefined();
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);
      // The agent's own write is still sitting there for the agent's own commit.
      expect(await fs.readFile(join(dir, 'doc.md'), 'utf8')).toBe('by the agent\n');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('moves no ref at all when no committer is wired', async () => {
    const { git, stack, cleanup } = await stackSetup({ committer: false });
    try {
      const outcome = await stack.exec('demo.edit', { to: 'edited' }, 'ui');
      expect(outcome.ok && outcome.record.commits).toBeUndefined();
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);
      expect(await git.isDirty()).toBe(true);
    } finally {
      await cleanup();
    }
  }, 20_000);
});
