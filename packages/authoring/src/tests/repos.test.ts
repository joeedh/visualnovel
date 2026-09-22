import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { Workspace } from '../index.js';

async function initRepo(dir: string): Promise<void> {
  const git = openGit(dir);
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'Test');
}

/** `fs.realpath` because temp dirs are symlinked on some platforms and git reports the target. */
async function tempDir(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-repos-')));
}

describe('Workspace.repos', () => {
  it('reports the project repo, and no second one when the bible lives inside it', async () => {
    const dir = await tempDir();
    try {
      await fs.mkdir(join(dir, 'wiki'));
      await initRepo(dir);
      expect(await new Workspace(dir).repos()).toEqual([
        { role: 'project', root: dir, owned: true },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the bible separately once wiki/ is a repo of its own', async () => {
    const dir = await tempDir();
    try {
      const wiki = join(dir, 'wiki');
      await fs.mkdir(wiki);
      await initRepo(dir);
      await initRepo(wiki);
      expect(await new Workspace(dir).repos()).toEqual([
        { role: 'project', root: dir, owned: true },
        { role: 'wiki', root: wiki, owned: true },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the base assets separately once assets/ is a repo of its own', async () => {
    const dir = await tempDir();
    try {
      const assets = join(dir, 'assets');
      await fs.mkdir(assets);
      await initRepo(dir);
      await initRepo(assets);
      expect(await new Workspace(dir).repos()).toEqual([
        { role: 'project', root: dir, owned: true },
        { role: 'base', root: assets, owned: true },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('names the enclosing repo, and says the project does not own it', async () => {
    const dir = await tempDir();
    try {
      await initRepo(dir);
      const project = join(dir, 'projects', 'mine');
      await fs.mkdir(project, { recursive: true });
      expect(await new Workspace(project).repos()).toEqual([
        { role: 'project', root: dir, owned: false },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a gitlink with no checkout as a missing wiki, which the project does not own', async () => {
    const dir = await tempDir();
    try {
      const wiki = join(dir, 'wiki');
      await fs.mkdir(wiki);
      await initRepo(dir);
      await initRepo(wiki);
      await fs.writeFile(join(wiki, 'note.md'), 'note\n');
      await openGit(wiki).commit({ message: 'wiki', paths: ['-A'] });
      await openGit(dir).commit({ message: 'record the wiki', paths: ['-A'] });
      // What a clone without `--recurse-submodules` leaves: the gitlink, and an empty directory
      await fs.rm(wiki, { recursive: true, force: true });
      await fs.mkdir(wiki);

      expect(await new Workspace(dir).repos()).toEqual([
        { role: 'project', root: dir, owned: true },
        { role: 'wiki', root: wiki, owned: false, missing: true },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing outside a work tree rather than throwing', async () => {
    const dir = await tempDir();
    try {
      expect(await new Workspace(dir).repos()).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
