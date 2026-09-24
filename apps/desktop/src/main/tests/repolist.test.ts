import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Committer } from '@vn/commands';
import { openGit } from '@vn/git';
import { RepoList } from '../workspace/repolist.js';
import { ensureRepo, type SubmoduleNotice } from '../workspace/workspace.js';

/** Runs git directly, for the verbs the wrapper does not expose (`submodule add`, `checkout`). */
function sh(dir: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, windowsHide: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

describe('RepoList', () => {
  let root: string;
  let upstream: string;
  let project: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'vn-repolist-')));
    upstream = join(root, 'bible');
    project = join(root, 'story');
    await mkdir(upstream);
    await writeFile(join(upstream, 'note.md'), 'first\n');
    await ensureRepo(upstream);
    await mkdir(project);
    await writeFile(join(project, 'project.yaml'), 'title: Story\n');
    await ensureRepo(project);
  }, 30_000);

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('commits in a submodule added after the project was opened', async () => {
    const posted: SubmoduleNotice[] = [];
    const list = new RepoList(project, { notice: (notices) => void posted.push(...notices) });
    expect(await list.open()).toEqual([]);
    expect((await list.current()).map((git) => git.root)).toEqual([project]);

    const url = upstream.replace(/\\/g, '/');
    await sh(project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', url, 'wiki']);
    const wikiDir = join(project, 'wiki');
    await openGit(wikiDir).config('user.email', 'test@example.com');
    await openGit(wikiDir).config('user.name', 'Test');
    // Detached, the way a recursive clone leaves it, so the lookup has something to report
    await sh(wikiDir, ['checkout', '-q', '--detach']);
    await writeFile(join(wikiDir, 'note.md'), 'written in the app\n');

    const committer = new Committer({ repos: () => list.current() });
    const commits = await committer.sweep('an act');
    const wiki = openGit(wikiDir);
    expect(commits.map((c) => c.repo).sort()).toEqual([project, wikiDir].sort());
    expect(await wiki.detached()).toBe(false);
    expect((await wiki.status()).dirty).toBe(false);
    expect(posted).toEqual([
      { level: 'info', message: expect.stringContaining('its saves now go to') },
    ]);
  }, 30_000);

  it('commits in a submodule outside wiki/, and in one nested inside another', async () => {
    const list = new RepoList(project);
    await list.open();
    const url = upstream.replace(/\\/g, '/');
    await sh(project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', url, 'lore']);
    const loreDir = join(project, 'lore');
    const lore = openGit(loreDir);
    await lore.config('user.email', 'test@example.com');
    await lore.config('user.name', 'Test');
    await sh(loreDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', url, 'inner']);
    const innerDir = join(loreDir, 'inner');
    await openGit(innerDir).config('user.email', 'test@example.com');
    await openGit(innerDir).config('user.name', 'Test');
    await sh(loreDir, ['commit', '-qm', 'add inner']);
    await sh(project, ['commit', '-qam', 'add lore']);

    await writeFile(join(loreDir, 'note.md'), 'edited in lore\n');
    await writeFile(join(innerDir, 'note.md'), 'edited in inner\n');
    const commits = await new Committer({ repos: () => list.current() }).sweep('an act');

    expect(commits.map((c) => c.repo).sort()).toEqual([project, loreDir, innerDir].sort());
    for (const dir of [project, loreDir, innerDir]) {
      expect((await openGit(dir).status()).dirty).toBe(false);
    }
  }, 30_000);

  it('does not repeat the lookup when nothing that decides it has changed', async () => {
    const list = new RepoList(project);
    await list.open();
    const before = await list.current();
    await writeFile(join(project, 'scene.md'), 'an edit\n');
    // A commit writes inside `.git`, which must not count as a change
    await new Committer({ repos: () => list.current() }).sweep('an act');
    expect(await list.current()).toBe(before);
  }, 30_000);
});
