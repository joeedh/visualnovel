/**
 * `git.pull` on a project whose `assets/` is a repository of its own, in real repositories with
 * bare shared copies: the base art is got first, a collision there stops before the project, and
 * a base art with no shared copy is skipped with a note.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandStack, type CommandOutcome } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import { openGit } from '@vn/git';
import { makeProject, type TestProject } from '@vn/testkit';
import { exists, readText } from '@vn/util';
import { UNDO_EXCLUDES } from '../../shared/affects.js';
import type { SyncOutcome } from '../../shared/history.js';
import { createDesktopRegistry, type CommandHost } from '../commands/index.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';
import { BASE_UNFINISHED } from '../session/sync.js';

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

let template: TestProject;
const made: string[] = [];

beforeAll(async () => {
  template = await makeProject();
}, 60_000);

afterAll(async () => {
  await template.cleanup();
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** Runs git in `cwd` with an identity of its own, answering what it printed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** Commits `paths` (everything when none) in `cwd`. */
function commit(cwd: string, message: string, paths: string[] = ['-A']): void {
  git(cwd, 'add', ...paths);
  git(cwd, 'commit', '-q', '-m', message);
}

/** Points `cwd`'s `main` at the bare copy `url`, as a project connected once would be. */
function connect(cwd: string, url: string): void {
  git(cwd, 'remote', 'add', 'origin', url);
  git(cwd, 'fetch', '-q', 'origin');
  git(cwd, 'branch', '-q', '-u', 'origin/main');
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-syncbase-')));
  made.push(dir);
  return dir;
}

/**
 * Two clones of one project whose `assets/` is its own repository. A made both and sent them; B
 * cloned the project, and the base art into its empty gitlink folder. With `baseCopy` false, the
 * base art has no shared copy and B's is a repository of its own.
 */
async function twoClones(baseCopy = true): Promise<{ a: string; b: string }> {
  const root = await tempDir();
  const a = join(root, 'a');
  await cp(template.dir, a, { recursive: true });
  await mkdir(join(a, 'assets'), { recursive: true });
  await writeFile(join(a, 'assets', 'plates.txt'), 'hall\n');
  git(join(a, 'assets'), 'init', '-q', '-b', 'main');
  commit(join(a, 'assets'), 'Base art');
  git(a, 'init', '-q', '-b', 'main');
  commit(a, 'Project');

  const project = join(root, 'project.git');
  git(root, 'clone', '-q', '--bare', a, project);
  connect(a, project);
  const b = join(root, 'b');
  git(root, 'clone', '-q', project, b);
  if (baseCopy) {
    const assets = join(root, 'assets.git');
    git(root, 'clone', '-q', '--bare', join(a, 'assets'), assets);
    connect(join(a, 'assets'), assets);
    git(root, 'clone', '-q', assets, join(b, 'assets'));
  } else {
    await writeFile(join(b, 'assets', 'plates.txt'), 'hall\n');
    git(join(b, 'assets'), 'init', '-q', '-b', 'main');
    commit(join(b, 'assets'), 'Base art');
  }
  return { a, b };
}

/** Opens a command stack over `dir`, with a `run` that throws on a refusal. */
function open(dir: string) {
  const session = new WorkspaceSession(dir, true, deps);
  const host = { session, ui: () => {}, uiAll: () => {} } as unknown as CommandHost;
  const stack = new CommandStack<CommandHost>({
    registry: createDesktopRegistry(),
    context: {
      root: dir,
      git : openGit(dir),
      host,
      log    : () => {},
      confirm: () => Promise.resolve(true),
    },
    journal : new UndoJournal({ root: dir, exclude: UNDO_EXCLUDES }),
  });
  const run = async (
    id: string,
    props: Record<string, unknown> = {},
  ): Promise<Extract<CommandOutcome, { ok: true }>> => {
    const outcome = await stack.exec(id, props, 'ui');
    if (!outcome.ok) throw new Error(`${id} refused: ${outcome.error}`);
    return outcome;
  };
  return { stack, run };
}

/** A file's text with line endings as written, whatever the machine's `core.autocrlf` checks out. */
const textOf = async (path: string): Promise<string> =>
  (await readText(path)).replace(/\r\n/g, '\n');

const repos = (outcome: Extract<CommandOutcome, { ok: true }>) =>
  (outcome.data as SyncOutcome).repos;

describe('getting their saves with the base art its own repository', () => {
  it('gets the base art first, then the project, each with its own rewrite table', async () => {
    const { a, b } = await twoClones();
    await writeFile(join(a, 'assets', 'sheets.txt'), 'aiko\n');
    commit(join(a, 'assets'), 'A draws a sheet');
    git(join(a, 'assets'), 'push', '-q');
    await writeFile(join(a, 'notes-a.md'), 'A\n');
    commit(a, 'A notes');
    git(a, 'push', '-q');

    // B's own saves in both, with the project's gitlink not yet recording B's base art save
    await writeFile(join(b, 'assets', 'portraits.txt'), 'haruki\n');
    commit(join(b, 'assets'), 'B draws a portrait');
    await writeFile(join(b, 'notes-b.md'), 'B\n');
    commit(b, 'B notes', ['notes-b.md']);

    const { run } = open(b);
    const outcome = await run('git.pull', { repo: 'project' });
    expect(repos(outcome)).toEqual([
      expect.objectContaining({ role: 'base', got: 1, replayed: 1, finished: true }),
      expect.objectContaining({ role: 'project', got: 1, replayed: 1, finished: true }),
    ]);
    for (const part of repos(outcome)) expect(part.rewrote).toHaveLength(1);
    expect(outcome.record.rewrote).toHaveLength(2);
    expect(outcome.record.message).toMatch(/^Base art: Got 1 save .* Project: Got 1 save /);
    expect(await textOf(join(b, 'assets', 'sheets.txt'))).toBe('aiko\n');
    expect(await textOf(join(b, 'notes-a.md'))).toBe('A\n');
  }, 60_000);

  it('stops before the project when the base art collides, and gets the project after', async () => {
    const { a, b } = await twoClones();
    await writeFile(join(a, 'assets', 'plates.txt'), 'hall, redrawn by A\n');
    commit(join(a, 'assets'), 'A redraws the hall');
    git(join(a, 'assets'), 'push', '-q');
    await writeFile(join(a, 'notes-a.md'), 'A\n');
    commit(a, 'A notes');
    git(a, 'push', '-q');
    await writeFile(join(b, 'assets', 'plates.txt'), 'hall, redrawn by B\n');
    commit(join(b, 'assets'), 'B redraws the hall');

    const { stack, run } = open(b);
    const stopped = await run('git.pull', { repo: 'project' });
    expect(repos(stopped)).toEqual([
      expect.objectContaining({ role: 'base', conflicted: ['plates.txt'], finished: false }),
    ]);
    expect(stopped.record.message).toContain(
      'The project waits until the base art’s sync finishes.',
    );
    expect(await exists(join(b, 'notes-a.md'))).toBe(false);
    expect(await stack.check('git.pull', { repo: 'project' })).toMatchObject({
      state  : 'refuse',
      message: BASE_UNFINISHED,
    });

    await run('git.resolve', { repo: 'base', path: 'plates.txt', side: 'mine' });
    const continued = await run('git.continueSync', { repo: 'base' });
    expect(continued.record.message).toContain('Now get their saves on the project.');

    const again = await run('git.pull', { repo: 'project' });
    expect(repos(again)).toEqual([
      expect.objectContaining({
        role: 'base',
        got : 0,
        note: expect.stringMatching(/^Nothing new/),
      }),
      expect.objectContaining({ role: 'project', got: 1, finished: true }),
    ]);
    expect(await textOf(join(b, 'notes-a.md'))).toBe('A\n');
    expect(await textOf(join(b, 'assets', 'plates.txt'))).toBe('hall, redrawn by B\n');
  }, 60_000);

  it('settles the gitlink when both saved base art, dropping a save that only moved it', async () => {
    const { a, b } = await twoClones();
    await writeFile(join(a, 'assets', 'sheets.txt'), 'aiko\n');
    commit(join(a, 'assets'), 'A draws a sheet');
    git(join(a, 'assets'), 'push', '-q');
    await writeFile(join(a, 'notes-a.md'), 'A\n');
    commit(a, 'A notes, recording the sheet');
    git(a, 'push', '-q');

    // Each of B's base art saves is recorded in the project, as commit-on-save does
    await writeFile(join(b, 'assets', 'portraits.txt'), 'haruki\n');
    commit(join(b, 'assets'), 'B draws a portrait');
    await writeFile(join(b, 'notes-b.md'), 'B\n');
    commit(b, 'B notes, recording the portrait');
    await writeFile(join(b, 'assets', 'portraits.txt'), 'haruki, redrawn\n');
    commit(join(b, 'assets'), 'B redraws the portrait');
    commit(b, 'B records the redraw', ['assets']);

    const { run } = open(b);
    const outcome = await run('git.pull', { repo: 'project' });
    const [base, project] = repos(outcome);
    expect(base).toMatchObject({ role: 'base', replayed: 2, finished: true });
    expect(project).toMatchObject({ role: 'project', conflicted: [], finished: true });
    expect(project!.rewrote).toHaveLength(2);
    expect(project!.rewrote.filter((r) => r.to === null)).toHaveLength(1);
    const head = git(join(b, 'assets'), 'rev-parse', 'HEAD');
    expect(git(b, 'ls-files', '-s', 'assets')).toMatch(new RegExp(`^160000 ${head} 0\\tassets$`));
    expect(await textOf(join(b, 'notes-a.md'))).toBe('A\n');
    expect(await textOf(join(b, 'notes-b.md'))).toBe('B\n');
  }, 60_000);

  it('gets a base art that syncs with its only remote by implication, and records it', async () => {
    const { a, b } = await twoClones();
    await writeFile(join(a, 'assets', 'sheets.txt'), 'aiko\n');
    commit(join(a, 'assets'), 'A draws a sheet');
    git(join(a, 'assets'), 'push', '-q');
    // As a base art connected with `git remote add` and a plain `git push` would be
    git(join(b, 'assets'), 'branch', '--unset-upstream');

    const { stack, run } = open(b);
    expect(await stack.check('git.pull', { repo: 'project' })).toMatchObject({
      state  : 'accept',
      message: expect.stringContaining('becomes the copy the base art syncs with'),
    });
    const outcome = await run('git.pull', { repo: 'project' });
    expect(repos(outcome)[0]).toMatchObject({ role: 'base', got: 1, finished: true });
    expect(git(join(b, 'assets'), 'config', '--get', 'branch.main.remote')).toBe('origin');
    expect(await textOf(join(b, 'assets', 'sheets.txt'))).toBe('aiko\n');
  }, 60_000);

  it('skips a base art with no shared copy, and says so', async () => {
    const { a, b } = await twoClones(false);
    await writeFile(join(a, 'notes-a.md'), 'A\n');
    commit(a, 'A notes');
    git(a, 'push', '-q');

    const { stack, run } = open(b);
    expect(await stack.check('git.pull', { repo: 'project' })).toMatchObject({
      state  : 'accept',
      message: expect.stringContaining(
        'The base art has no shared copy to get from, so it is skipped.',
      ),
    });
    const outcome = await run('git.pull', { repo: 'project' });
    expect(repos(outcome)).toEqual([
      expect.objectContaining({
        role: 'base',
        got : 0,
        note: 'The base art has no shared copy to get from, so it is skipped.',
      }),
      expect.objectContaining({ role: 'project', got: 1, finished: true }),
    ]);
    expect(await textOf(join(b, 'notes-a.md'))).toBe('A\n');
  }, 60_000);
});
