import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { loadConfig } from '@vn/config';
import { modelFromInputs } from '@vn/model';
import { ProjectPaths, loadInputs } from '@vn/store';
import {
  RECENT_KEY,
  RECENT_MAX,
  START_SCENE,
  createWorkspace,
  ensureRepo,
  inspectCreate,
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

describe('inspectCreate', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-create-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('tells a path with nothing to lose from one with something', async () => {
    const missing = join(root, 'deep', 'new');
    const empty = join(root, 'empty');
    const full = join(root, 'full');
    const file = join(root, 'a-file.txt');
    await mkdir(empty);
    await mkdir(full);
    await writeFile(join(full, 'notes.md'), 'mine\n');
    await writeFile(file, 'hello');

    expect(await inspectCreate(missing)).toMatchObject({
      exists: false,
      directory: false,
      empty: true,
    });
    expect(await inspectCreate(empty)).toMatchObject({
      exists: true,
      directory: true,
      empty: true,
    });
    expect(await inspectCreate(full)).toMatchObject({
      exists: true,
      directory: true,
      empty: false,
    });
    expect(await inspectCreate(file)).toMatchObject({
      exists: true,
      directory: false,
      empty: false,
    });

    // Read-only, including the walk up for `insideRepo`.
    expect(await readdir(empty)).toEqual([]);
    expect(await readdir(root)).not.toContain('deep');
  });

  it('names the repo that already owns the path, walking up past what does not exist yet', async () => {
    expect((await inspectCreate(join(root, 'nested'))).insideRepo).toBeUndefined();

    await writeFile(join(root, 'notes.md'), 'the outer repo\n');
    await ensureRepo(root);
    // The target is two levels below the repo root and neither level exists — the warning has to
    // be available *before* the directory is made, or its symptom has no visible cause.
    const inside = await inspectCreate(join(root, 'projects', 'mine'));
    expect(inside.exists).toBe(false);
    expect(inside.insideRepo).toBeDefined();
  }, 20_000);
});

describe('createWorkspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-new-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('scaffolds a project that builds a model with no errors, and commits it', async () => {
    const dir = join(root, 'my-story');

    expect(await createWorkspace(dir, 'My Story')).toEqual({
      root: dir,
      created: true,
      title: 'My Story',
    });
    expect((await readdir(dir)).sort()).toEqual(['.git', 'project.yaml', 'scenes', 'wiki']);

    const config = await loadConfig(dir);
    expect(config).toMatchObject({ title: 'My Story', start: START_SCENE });

    // The whole point of the skeleton: an author's first sight of a new project is not a red count.
    const model = modelFromInputs(await loadInputs(new ProjectPaths(dir)), {
      title: config.title,
      start: config.start,
    });
    expect(model.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect([...model.scenes.keys()]).toEqual([START_SCENE]);
    expect(model.entry).toBe(START_SCENE);

    const git = openGit(dir);
    expect((await git.log()).map((c) => c.subject)).toEqual(['New project']);
    expect((await git.status()).dirty).toBe(false);
  }, 20_000);

  it('titles the project after the directory when asked for nothing else', async () => {
    const dir = join(root, 'the-transfer-student');
    expect((await createWorkspace(dir, 'the-transfer-student')).title).toBe('the-transfer-student');
  }, 20_000);

  it('refuses a directory with files in it rather than merging into it', async () => {
    const dir = join(root, 'theirs');
    await mkdir(dir);
    await writeFile(join(dir, 'notes.md'), 'not mine to touch\n');

    await expect(createWorkspace(dir, 'Theirs')).rejects.toThrow('not empty');
    expect(await readdir(dir)).toEqual(['notes.md']);
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
