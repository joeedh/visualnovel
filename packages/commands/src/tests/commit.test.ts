import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit, type Git } from '@vn/git';
import { defineFor, type CommandRecord } from '../command.js';
import { Committer } from '../commit.js';
import { prop } from '../props.js';
import { CommandRegistry } from '../registry.js';
import { BATCH_IDLE_MS, CommandStack } from '../stack.js';
import { UndoJournal } from '../undo.js';

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

/** The `Vn-*` trailer lines of a commit, in the order they were written. */
async function trailersOf(git: Git, sha: string): Promise<string[]> {
  return (await git.show(sha))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Vn-'));
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

describe('Committer.commitBatch', () => {
  it('commits nothing for an empty batch', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      expect(await new Committer({ repos: () => [git] }).commitBatch([])).toEqual([]);
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);
      expect(await git.isDirty()).toBe(true);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('produces the same subject and trailers as commit() for one record', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      const committer = new Committer({ repos: () => [git] });
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      const [alone] = await committer.commit(record());
      await fs.writeFile(join(dir, 'doc.md'), 'edited again\n');
      const [batched] = await committer.commitBatch([record()]);

      const [second, first] = await git.log(2);
      expect(second!.subject).toBe(first!.subject);
      expect(await trailersOf(git, batched!.sha)).toEqual(await trailersOf(git, alone!.sha));
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('names the last act and the count, and folds the run into one set of trailers', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      const records = Array.from({ length: 30 }, (_, i) =>
        record({
          seq: 41 + i,
          id: i % 2 === 0 ? 'gengraph.setProp' : 'gengraph.moveNodes',
          invocation: `gengraph.setProp(value=${i})`,
          message: `Set aspect to 16:${i}`,
        }),
      );

      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      const [commit] = await new Committer({ repos: () => [git] }).commitBatch(records);

      expect((await git.log(1))[0]!.subject).toBe('Set aspect to 16:29 (and 29 more edits)');
      expect(await trailersOf(git, commit!.sha)).toEqual([
        'Vn-Batch: 30 seqs 41-70',
        'Vn-Seq: 70',
        'Vn-Command: gengraph.setProp, gengraph.moveNodes',
        'Vn-Source: ui',
      ]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('renders the gaps in a batch rather than a span across them', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      const records = [41, 43, 45, 46, 47].map((seq) => record({ seq }));
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      const [commit] = await new Committer({ repos: () => [git] }).commitBatch(records);
      expect(await trailersOf(git, commit!.sha)).toContain('Vn-Batch: 5 seqs 41,43,45-47');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('keeps the count when the base subject is long enough to be truncated', async () => {
    const { dir, git, cleanup } = await tempProject();
    try {
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      await new Committer({ repos: () => [git] }).commitBatch([
        record({ seq: 1 }),
        record({ seq: 2, message: `${'a very long summary '.repeat(8)}.` }),
      ]);

      const [head] = await git.log(1);
      expect(head!.subject).toHaveLength(72);
      expect(head!.subject.endsWith('… (and 1 more edit)')).toBe(true);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('produces one commit in each repo the run touched', async () => {
    const one = await tempProject();
    const two = await tempProject();
    try {
      await fs.writeFile(join(one.dir, 'doc.md'), 'edited\n');
      await fs.writeFile(join(two.dir, 'doc.md'), 'edited\n');
      const committer = new Committer({ repos: () => [one.git, two.git] });
      const commits = await committer.commitBatch([record({ seq: 1 }), record({ seq: 2 })]);

      expect(commits.map((c) => c.repo)).toEqual([one.dir, two.dir]);
      for (const git of [one.git, two.git]) {
        expect((await git.log(1))[0]!.subject).toBe('Moved L4 into scene two (and 1 more edit)');
      }
    } finally {
      await one.cleanup();
      await two.cleanup();
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

/** The paths a commit touched, from its patch. */
async function filesIn(git: Git, sha: string): Promise<string[]> {
  return [...(await git.show(sha)).matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]!).sort();
}

/** A latch a test opens by hand, and a promise that settles once a command reaches it. */
function latch() {
  let open!: () => void;
  let arrive!: () => void;
  const held = new Promise<void>((resolve) => (open = resolve));
  const entered = new Promise<void>((resolve) => (arrive = resolve));
  return { held, entered, open, arrive };
}

/** A hand-driven stand-in for `setTimeout`, so a test fires the idle flush rather than waiting. */
function fakeTimer() {
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    set(fn: () => void, ms: number): number {
      const handle = next++;
      armed.set(handle, { fn, ms });
      return handle;
    },
    clear(handle: unknown): void {
      armed.delete(handle as number);
    },
    /** The delay the armed timer waits for, or null when none is armed. */
    armedMs(): number | null {
      return [...armed.values()][0]?.ms ?? null;
    },
    /** Run every armed timer, as the event loop would. */
    fire(): void {
      const due = [...armed.values()];
      armed.clear();
      for (const { fn } of due) fn();
    },
  };
}

/**
 * Waits for a flush the stack started on its own, which it does not hand back a promise for.
 * Throws rather than hanging when the commit never arrives, so a broken timer fails by name.
 */
async function committed(git: Git, count: number): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    const log = await git.log();
    if (log.length >= count) return log.map((c) => c.subject);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`only ${(await git.log()).length} commit(s) landed, expected ${count}`);
}

/** A stack whose commands each write one named file, two of which defer their commits. */
async function batchSetup(
  opts: {
    committer?: boolean;
    repos?: (git: Git) => Git[];
    journal?: boolean;
    onCommitError?(error: unknown, records: CommandRecord[]): void;
  } = {},
) {
  const { dir, git, cleanup } = await tempProject();
  const gate = latch();
  const write = (file: string): Promise<void> => fs.writeFile(join(dir, file), `${file}\n`);
  const registry = new CommandRegistry<Host>();
  registry.registerAll([
    define({
      id: 'demo.defer',
      title: 'Defer',
      description: 'Write a document, leaving the commit to a later act.',
      mutating: true,
      undoable: true,
      defersCommit: true,
      props: { file: prop.string('the document to write') },
      async run(props) {
        await write(props.file);
        return { message: `wrote ${props.file}` };
      },
    }),
    define({
      id: 'demo.slow',
      title: 'Slow',
      description: 'Write a document, then wait to be released.',
      mutating: true,
      defersCommit: true,
      props: { file: prop.string('the document to write') },
      async run(props) {
        await write(props.file);
        gate.arrive();
        await gate.held;
        return { message: `wrote ${props.file}` };
      },
    }),
    define({
      id: 'demo.write',
      title: 'Write',
      description: 'Write a document and commit it.',
      mutating: true,
      undoable: true,
      props: { file: prop.string('the document to write') },
      async run(props) {
        await write(props.file);
        return { message: `wrote ${props.file}` };
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
  const repos = opts.repos ?? ((only: Git) => [only]);
  const timer = fakeTimer();
  const stack = new CommandStack<Host>({
    registry,
    context: { root: dir, git, host: { writes: 0 }, log: () => {} },
    timer,
    ...(opts.committer === false ? {} : { committer: new Committer({ repos: () => repos(git) }) }),
    ...(opts.journal ? { journal: new UndoJournal({ root: dir }) } : {}),
    ...(opts.onCommitError ? { onCommitError: opts.onCommitError } : {}),
  });
  return { dir, git, stack, gate, timer, registry, cleanup };
}

describe('deferred commit-on-save', () => {
  it('holds a run of deferring commands back, and marks each record', async () => {
    const { git, stack, cleanup } = await batchSetup();
    try {
      for (const file of ['a.md', 'b.md', 'c.md']) {
        const outcome = await stack.exec('demo.defer', { file }, 'ui');
        expect(outcome.ok && outcome.record.commitDeferred).toBe(true);
        expect(outcome.ok && outcome.record.commits).toBeUndefined();
      }
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);
      expect(await git.isDirty()).toBe(true);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('gives the run its own commit before the next act writes anything', async () => {
    const { git, stack, cleanup } = await batchSetup();
    try {
      for (const file of ['a.md', 'b.md', 'c.md']) {
        await stack.exec('demo.defer', { file }, 'ui');
      }
      const outcome = await stack.exec('demo.write', { file: 'd.md' }, 'ui');

      const [own, flushed] = await git.log(2);
      expect(own!.subject).toBe('wrote d.md');
      expect(flushed!.subject).toBe('wrote c.md (and 2 more edits)');
      expect(outcome.ok && outcome.record.commits?.[0]!.sha).toBe(own!.hash);

      // The reason the flush runs before `run` rather than before the commit: at that moment the
      // only dirty content is the deferred edits, so neither commit can claim the other's files.
      expect(await filesIn(git, flushed!.hash)).toEqual(['a.md', 'b.md', 'c.md']);
      expect(await filesIn(git, own!.hash)).toEqual(['d.md']);
      expect(await git.isDirty()).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('is not ended by a command that writes nothing, and does not claim the seq it took', async () => {
    const { git, stack, cleanup } = await batchSetup();
    try {
      await stack.exec('demo.defer', { file: 'a.md' }, 'ui');
      await stack.exec('demo.look', {}, 'ui');
      await stack.exec('demo.defer', { file: 'b.md' }, 'ui');
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);

      const commits = await stack.flushCommits();
      expect(await trailersOf(git, commits[0]!.sha)).toContain('Vn-Batch: 2 seqs 1,3');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('never defers when no committer is wired', async () => {
    const { git, stack, cleanup } = await batchSetup({ committer: false });
    try {
      const outcome = await stack.exec('demo.defer', { file: 'a.md' }, 'ui');
      expect(outcome.ok && outcome.record.commitDeferred).toBeUndefined();
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('drains the batch on a machine that owns no repo to commit into', async () => {
    let owned: Git[] = [];
    const { git, stack, cleanup } = await batchSetup({ repos: () => owned });
    try {
      for (const file of ['a.md', 'b.md', 'c.md']) {
        await stack.exec('demo.defer', { file }, 'ui');
      }
      expect(await stack.flushCommits()).toEqual([]);

      // The three are gone rather than waiting for a repo that may never arrive, so the next
      // batch holds the fourth edit alone. The trailers are what say so: `-A` sweeps the three
      // files into the commit either way, and a lingering batch would name them here.
      await stack.exec('demo.defer', { file: 'd.md' }, 'ui');
      owned = [git];
      const commits = await stack.flushCommits();
      const trailers = await trailersOf(git, commits[0]!.sha);
      expect(trailers).toContain('Vn-Seq: 4');
      expect(trailers.some((line) => line.startsWith('Vn-Batch:'))).toBe(false);
      expect((await git.log(1))[0]!.subject).toBe('wrote d.md');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('commits the run before undo restores over it', async () => {
    const { git, stack, cleanup } = await batchSetup({ journal: true });
    try {
      await stack.exec('demo.write', { file: 'd.md' }, 'ui');
      await stack.exec('demo.defer', { file: 'a.md' }, 'ui');

      // The deferring act is itself the undo target: any earlier one is refused, because a
      // pending batch is drift against the snapshot `UndoJournal.check` compares to.
      const undone = await stack.undo();
      expect(undone.ok).toBe(true);

      const [own, flushed] = await git.log(2);
      expect(flushed!.subject).toBe('wrote a.md');
      expect(await filesIn(git, flushed!.hash)).toEqual(['a.md']);
      // Without the flush the restore would delete a.md having never committed it, and the only
      // record of the edit would be gone.
      expect(own!.subject.startsWith('Undid demo.defer')).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('keeps a command that started first out of a commit that started second', async () => {
    const { git, stack, gate, cleanup } = await batchSetup();
    try {
      const slow = stack.exec('demo.slow', { file: 'a.md' }, 'ui');
      await gate.entered;
      // Issued while `demo.slow` is inside `run`, with a.md already on disk. Unserialized, its
      // `-A` commit sweeps a.md into the same commit as d.md.
      const fast = stack.exec('demo.write', { file: 'd.md' }, 'ui');
      gate.open();
      await Promise.all([slow, fast]);

      const [own, flushed] = await git.log(2);
      expect(await filesIn(git, own!.hash)).toEqual(['d.md']);
      expect(await filesIn(git, flushed!.hash)).toEqual(['a.md']);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

describe('the idle flush', () => {
  it('commits a batch that nothing else came to end', async () => {
    const { git, stack, timer, cleanup } = await batchSetup();
    try {
      await stack.exec('demo.defer', { file: 'a.md' }, 'ui');
      await stack.exec('demo.defer', { file: 'b.md' }, 'ui');
      expect(timer.armedMs()).toBe(BATCH_IDLE_MS);

      timer.fire();
      expect(await committed(git, 2)).toEqual(['wrote b.md (and 1 more edit)', 'init']);
      expect(await git.isDirty()).toBe(false);
      // The fired flush is not handed back, so join the chain it took before tearing the repo down.
      await stack.flushCommits();
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('is cancelled by a flush, so it cannot fire against an empty batch', async () => {
    const { git, stack, timer, cleanup } = await batchSetup();
    try {
      await stack.exec('demo.defer', { file: 'a.md' }, 'ui');
      await stack.flushCommits();
      expect(timer.armedMs()).toBeNull();

      timer.fire();
      expect((await git.log()).map((c) => c.subject)).toEqual(['wrote a.md', 'init']);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('is given up on dispose, along with deferring at all', async () => {
    const { git, stack, timer, cleanup } = await batchSetup();
    try {
      await stack.exec('demo.defer', { file: 'a.md' }, 'ui');
      await stack.dispose();
      expect(timer.armedMs()).toBeNull();
      expect(await git.isDirty()).toBe(false);

      const after = await stack.exec('demo.defer', { file: 'b.md' }, 'ui');
      expect(after.ok && after.record.commitDeferred).toBeUndefined();
      expect(after.ok && after.record.commits).toHaveLength(1);
      expect(timer.armedMs()).toBeNull();
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('is given up from inside the command dropping the stack, without deadlocking', async () => {
    const { git, stack, registry, cleanup } = await batchSetup();
    try {
      registry.register(
        define({
          id: 'demo.switch',
          title: 'Switch',
          description: 'Drop the stack from inside a command, the way a workspace switch does.',
          mutating: true,
          props: {},
          async run() {
            // The desktop reaches `dispose` this way and no other. Through the chain it would
            // queue behind the command calling it and never return.
            await stack.dispose();
            return { message: 'switched' };
          },
        }),
      );
      await stack.exec('demo.defer', { file: 'a.md' }, 'ui');
      expect((await stack.exec('demo.switch', {}, 'ui')).ok).toBe(true);
      // `demo.switch` writes nothing, so it leaves no commit of its own behind the flushed batch.
      expect((await git.log()).map((c) => c.subject)).toEqual(['wrote a.md', 'init']);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('keeps a batch its commit refused, reports it once, and lands it all later', async () => {
    let broken = true;
    const reported: { error: unknown; records: CommandRecord[] }[] = [];
    const { git, stack, cleanup } = await batchSetup({
      repos: (only) => {
        if (broken) throw new Error('git is not available');
        return [only];
      },
      onCommitError: (error, records) => void reported.push({ error, records }),
    });
    try {
      await stack.exec('demo.defer', { file: 'a.md' }, 'ui');
      await stack.exec('demo.defer', { file: 'b.md' }, 'ui');
      expect(await stack.flushCommits()).toEqual([]);
      expect(reported).toHaveLength(1);
      expect(String(reported[0]!.error)).toContain('git is not available');
      expect(reported[0]!.records.map((r) => r.seq)).toEqual([1, 2]);
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);

      broken = false;
      await stack.exec('demo.defer', { file: 'c.md' }, 'ui');
      await stack.flushCommits();
      const [head] = await git.log(1);
      expect(head!.subject).toBe('wrote c.md (and 2 more edits)');
      expect(await filesIn(git, head!.hash)).toEqual(['a.md', 'b.md', 'c.md']);
      expect(reported).toHaveLength(1);
    } finally {
      await cleanup();
    }
  }, 20_000);
});
