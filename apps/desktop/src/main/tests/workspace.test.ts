import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import {
  RECENT_KEY,
  RECENT_MAX,
  ensureRepo,
  inspectWorkspace,
  openWorkspace,
  recentWorkspaces,
  rememberWorkspace,
  seedWorkspace,
  type RecentStore,
} from '../workspace.js';

/** A template shaped like `examples/sample`: authored inputs plus a previous run's output. */
async function makeTemplate(dir: string): Promise<void> {
  await mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await mkdir(join(dir, 'screenplay'), { recursive: true });
  await mkdir(join(dir, 'vngen', 'build', 'assets'), { recursive: true });
  await mkdir(join(dir, 'keys'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'title: Sample\n');
  await writeFile(join(dir, 'characters', 'aiko', 'character.md'), '---\nid: aiko\n---\n');
  await writeFile(join(dir, 'screenplay', 'script.fountain'), '# arrival\n');
  await writeFile(join(dir, 'vngen', 'build', 'assets', 'deadbeef.png'), 'not really a png');
  await writeFile(join(dir, 'keys', 'gemini.key'), 'sk-secret');
}

describe('seedWorkspace', () => {
  let root: string;
  let template: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-seed-'));
    template = join(root, 'sample');
    target = join(root, 'mySampleRepo');
    await makeTemplate(template);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('copies the authored inputs, leaves out output and secrets, and commits them', async () => {
    const result = await seedWorkspace(template, target);
    expect(result).toEqual({ root: target, seeded: true });

    expect((await readdir(target)).sort()).toEqual([
      '.git',
      'characters',
      'project.yaml',
      'screenplay',
    ]);
    expect(await readFile(join(target, 'project.yaml'), 'utf8')).toBe('title: Sample\n');

    // A fresh workspace has not been run: nothing may claim it has.
    const git = openGit(target);
    expect(await git.isRepo()).toBe(true);
    expect((await git.log()).map((c) => c.subject)).toEqual(['Sample project inputs']);
    expect((await git.status()).dirty).toBe(false);
  }, 20_000);

  it('opens an existing workspace untouched', async () => {
    await seedWorkspace(template, target);
    await writeFile(join(target, 'project.yaml'), 'title: Mine\n');

    const again = await seedWorkspace(template, target);
    expect(again).toEqual({ root: target, seeded: false });
    // Re-copying would silently discard a day's authoring, so it must not happen.
    expect(await readFile(join(target, 'project.yaml'), 'utf8')).toBe('title: Mine\n');
  }, 20_000);

  it('fails by name when there is no template to seed from', async () => {
    const missing = join(root, 'nope');
    await expect(seedWorkspace(missing, target)).rejects.toThrow(missing);
  });
});

describe('ensureRepo', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-ensure-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('initializes a repo around a directory the user picked, and commits what is there', async () => {
    const dir = join(root, 'my-story');
    await mkdir(dir);
    await writeFile(join(dir, 'project.yaml'), 'title: Mine\n');

    const git = await ensureRepo(dir);
    expect(await git.isRepo()).toBe(true);
    expect((await git.log()).map((c) => c.subject)).toEqual(['Existing project files']);
    expect((await git.status()).dirty).toBe(false);
  }, 20_000);

  it('leaves an existing repo alone, including one the directory merely sits inside', async () => {
    await writeFile(join(root, 'notes.md'), 'the outer repo\n');
    await ensureRepo(root);
    const nested = join(root, 'projects', 'mine');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'project.yaml'), 'title: Nested\n');

    await ensureRepo(nested);
    // No second `.git`: `git init` here would carve a repo out of one that already owns it.
    expect(await readdir(nested)).toEqual(['project.yaml']);
    expect((await openGit(root).log()).map((c) => c.subject)).toEqual(['Existing project files']);
  }, 20_000);
});

describe('openWorkspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-open-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('makes a project out of an empty directory the user picked', async () => {
    const dir = join(root, 'my story');
    await mkdir(dir);

    const opened = await openWorkspace(dir);
    expect(opened).toEqual({ root: dir, created: true, title: 'my story' });
    // The shortest honest config: every other key has a default.
    expect(await readFile(join(dir, 'project.yaml'), 'utf8')).toBe('title: "my story"\n');
    expect(await readdir(dir)).toEqual(['.git', 'project.yaml']);

    const git = openGit(dir);
    expect((await git.log()).map((c) => c.subject)).toEqual(['New project']);
    expect((await git.status()).dirty).toBe(false);
  }, 20_000);

  it('commits what is already there rather than seeding anything', async () => {
    const dir = join(root, 'notes');
    await mkdir(join(dir, 'scenes'), { recursive: true });
    await writeFile(join(dir, 'scenes', 'arrival.md'), '---\nscene: arrival\n---\n');

    const opened = await openWorkspace(dir);
    expect(opened.created).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['.git', 'project.yaml', 'scenes']);
    expect((await openGit(dir).status()).dirty).toBe(false);
  }, 20_000);

  it('opens an existing project under its own title, writing no config', async () => {
    const dir = join(root, 'mine');
    await mkdir(dir);
    await writeFile(join(dir, 'project.yaml'), '# hand written\ntitle: The Transfer Student\n');

    expect(await openWorkspace(dir)).toEqual({
      root: dir,
      created: false,
      title: 'The Transfer Student',
    });
    expect(await readFile(join(dir, 'project.yaml'), 'utf8')).toBe(
      '# hand written\ntitle: The Transfer Student\n',
    );
  }, 20_000);

  it('is idempotent: opening twice changes nothing the second time', async () => {
    const dir = join(root, 'twice');
    await mkdir(dir);
    await openWorkspace(dir);
    const before = await openGit(dir).log();

    expect((await openWorkspace(dir)).created).toBe(false);
    expect(await openGit(dir).log()).toEqual(before);
  }, 20_000);

  it('refuses a config that will not parse instead of opening a broken project', async () => {
    const dir = join(root, 'broken');
    await mkdir(dir);
    await writeFile(join(dir, 'project.yaml'), 'title: []\n');

    await expect(openWorkspace(dir)).rejects.toThrow('project.yaml');
    expect(await readdir(dir)).toEqual(['project.yaml']);
  });

  it('refuses a path that is not a directory', async () => {
    const file = join(root, 'a-file.txt');
    await writeFile(file, 'hello');
    await expect(openWorkspace(file)).rejects.toThrow('not a directory');
    await expect(openWorkspace(join(root, 'nope'))).rejects.toThrow('not a directory');
  });
});

describe('inspectWorkspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-inspect-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('tells open from create from refuse, and writes nothing doing it', async () => {
    const empty = join(root, 'empty');
    const project = join(root, 'project');
    const broken = join(root, 'broken');
    await mkdir(empty);
    await mkdir(project);
    await mkdir(broken);
    await writeFile(join(project, 'project.yaml'), 'title: Mine\n');
    await writeFile(join(broken, 'project.yaml'), 'title: 3\n');

    expect(await inspectWorkspace(empty)).toEqual({ root: empty, directory: true, project: false });
    expect(await inspectWorkspace(project)).toEqual({
      root: project,
      directory: true,
      project: true,
      title: 'Mine',
    });
    expect((await inspectWorkspace(broken)).problem).toContain('project.yaml');
    expect(await inspectWorkspace(join(root, 'nope'))).toMatchObject({ directory: false });

    expect(await readdir(empty)).toEqual([]);
  });
});

describe('recent workspaces', () => {
  /** Just enough `SessionStore` to be the thing the helpers actually run against. */
  function store(initial: string[] = []): RecentStore & { value: string[] } {
    const state: Record<string, unknown> = { [RECENT_KEY]: initial };
    return {
      get: <T extends string[]>(key: string, fallback: T) => (state[key] as T) ?? fallback,
      set: (key, value) => {
        state[key] = value;
      },
      get value() {
        return state[RECENT_KEY] as string[];
      },
    };
  }

  it('moves the newest to the front and keeps one entry per project', () => {
    const state = store(['/b', '/a']);
    expect(rememberWorkspace(state, '/a')).toEqual(['/a', '/b']);
    expect(rememberWorkspace(state, '/c')).toEqual(['/c', '/a', '/b']);
    expect(state.value).toEqual(['/c', '/a', '/b']);
  });

  it('keeps the list bounded', () => {
    const state = store(Array.from({ length: RECENT_MAX }, (_, i) => `/p${i}`));
    expect(rememberWorkspace(state, '/new')).toHaveLength(RECENT_MAX);
    expect(state.value[0]).toBe('/new');
    expect(state.value).not.toContain(`/p${RECENT_MAX - 1}`);
  });

  it('reads a corrupt list as an empty one — it must never block a launch', () => {
    const bad = { get: <T>(_k: string, _f: T) => 'not a list' as T, set: () => {} };
    expect(recentWorkspaces(bad as unknown as RecentStore)).toEqual([]);
    expect(recentWorkspaces(store([1 as unknown as string, '/a']))).toEqual(['/a']);
  });
});
