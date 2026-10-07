/**
 * A project whose shared copy was connected in a terminal: `git remote add`, and a plain
 * `git push` or none at all, leave the branch following nothing. An only remote is then the copy
 * the branch syncs with, and the first get or send through it records that as `push -u` would;
 * with several and none recorded, the sync verbs ask for a choice.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_SYNC_CHOSEN, NO_UPSTREAM } from '@vn/git';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

function sh(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

/** The branch's recorded upstream remote, or empty when none is recorded. */
const tracked = (dir: string, branch: string): Promise<string> =>
  sh(dir, ['config', '--get', `branch.${branch}.remote`]).catch(() => '');

let root: string;
let bare: string;
let other: string;
let branch: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'vn-unsynced-')));
  bare = await mkdtemp(join(tmpdir(), 'vn-unsynced-bare-'));
  other = await mkdtemp(join(tmpdir(), 'vn-unsynced-other-'));
  await writeFile(join(root, 'project.yaml'), 'title: Unsynced\n');
  await sh(root, ['init', '-q']);
  await sh(root, ['config', 'user.name', 'Author']);
  await sh(root, ['config', 'user.email', 'author@example.com']);
  await sh(root, ['add', '-A']);
  await sh(root, ['commit', '-q', '-m', 'New project']);
  branch = await sh(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  await sh(bare, ['init', '--bare', '-q']);
  await sh(other, ['init', '--bare', '-q']);
}, 60_000);

afterEach(async () => {
  for (const dir of [root, bare, other]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('a shared copy connected outside the app', () => {
  it('is the copy an only remote syncs with, and a get records it', async () => {
    await sh(root, ['remote', 'add', 'origin', bare]);
    await sh(root, ['push', '-q', 'origin', branch]);
    const session = new WorkspaceSession(root, true, deps);

    const status = await session.gitStatus('project', 0);
    expect(status.upstream).toBe(`origin/${branch}`);
    expect([status.ahead, status.behind]).toEqual([0, 0]);
    expect(status.remotes).toEqual([
      { name: 'origin', url: bare, ahead: 0, behind: 0, syncsWith: true },
    ]);
    const preview = await session.previewPull('project');
    expect(preview).toMatchObject({ ok: true, note: expect.stringContaining('becomes the copy') });

    expect(await tracked(root, branch)).toBe('');
    await session.gitPull('project');
    expect(await tracked(root, branch)).toBe('origin');
  }, 60_000);

  it('records an only remote on the first send, as push -u would', async () => {
    await sh(root, ['remote', 'add', 'origin', bare]);
    const session = new WorkspaceSession(root, true, deps);

    expect((await session.gitStatus('project', 0)).upstream).toBe(`origin/${branch}`);
    // The copy has no branch yet, so a get has nothing to record
    expect((await session.gitPull('project')).note).toContain('send your saves first');
    expect(await tracked(root, branch)).toBe('');

    await session.gitPush('project', '');
    expect(await tracked(root, branch)).toBe('origin');
    expect(await sh(bare, ['rev-parse', branch])).toBe(await sh(root, ['rev-parse', 'HEAD']));
  }, 60_000);

  it('asks for a choice among several copies, none of them recorded', async () => {
    await sh(root, ['remote', 'add', 'origin', bare]);
    await sh(root, ['remote', 'add', 'backup', other]);
    const session = new WorkspaceSession(root, true, deps);

    const status = await session.gitStatus('project', 0);
    expect(status.upstream).toBeNull();
    expect(status.remotes.map((r) => [r.name, r.syncsWith])).toEqual([
      ['backup', false],
      ['origin', false],
    ]);
    expect(await session.previewPull('project')).toEqual({ ok: false, reason: NO_SYNC_CHOSEN });

    await session.gitSyncWith('project', 'origin');
    expect((await session.gitStatus('project', 0)).upstream).toBe(`origin/${branch}`);
  }, 60_000);

  it('still reads as none connected when the repository has no remote', async () => {
    const session = new WorkspaceSession(root, true, deps);
    expect((await session.gitStatus('project', 0)).remotes).toEqual([]);
    expect(await session.previewPull('project')).toEqual({ ok: false, reason: NO_UPSTREAM });
  }, 60_000);

  // git prints the drive letter upper-cased, whatever spelling the project was opened under
  (process.platform === 'win32' ? it : it.skip)(
    'owns a project opened with a lower-case drive letter',
    async () => {
      await sh(root, ['remote', 'add', 'origin', bare]);
      const typed = root[0]!.toLowerCase() + root.slice(1).replaceAll('\\', '/');
      const session = new WorkspaceSession(typed, true, deps);
      expect(await session.gitRepos()).toEqual([{ role: 'project', root, owned: true }]);
      expect((await session.previewPush('project', '')).ok).toBe(true);
    },
    60_000,
  );
});
