import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { UndoJournal } from '@vn/commands/snapshot';
import { loadConfig } from '@vn/config';
import { modelFromInputs } from '@vn/model';
import { ProjectPaths, loadInputs } from '@vn/store';
import { noteGitHealth } from '../doctor.js';
import {
  RECENT_KEY,
  RECENT_MAX,
  SESSION_IGNORE,
  START_SCENE,
  commitScaffolding,
  createRoot,
  createWorkspace,
  ensureGitAttributes,
  ensureRepo,
  inspectCreate,
  inspectWorkspace,
  openWorkspace,
  recentWorkspaces,
  rememberWorkspace,
  seedWorkspace,
  UNDO_EXCLUDES,
  writeScaffolding,
  type RecentStore,
} from '../workspace.js';

/** A template shaped like `templates/basic`: authored inputs plus a previous run's output. */
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
      '.gitignore',
      'characters',
      'project.yaml',
      'screenplay',
    ]);
    // `keys` must be ignored before anything else, because commit-on-save runs `git commit -A`.
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toContain('keys\n');
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

  // A machine without git gets an app that opens rather than one that dies on `git init` before
  // its first window. `initRepoAt` still throws — see the comment there for why.
  it('hands back a handle rather than initializing when git is absent', async () => {
    const dir = join(root, 'no-git');
    await mkdir(dir);
    await writeFile(join(dir, 'project.yaml'), 'title: Mine\n');

    noteGitHealth({ ok: false });
    try {
      const git = await ensureRepo(dir);
      expect(await git.isRepo()).toBe(false);
    } finally {
      noteGitHealth({ ok: true });
    }
  }, 20_000);

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
    // This is the shortest honest config, because every other key has a default.
    expect(await readFile(join(dir, 'project.yaml'), 'utf8')).toBe('title: "my story"\n');
    // Opening scaffolds the layout templates and the rule that keeps git from merging one.
    expect((await readdir(dir)).sort()).toEqual([
      '.git',
      '.gitattributes',
      '.gitignore',
      '.vnstudio',
      'project.yaml',
    ]);

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
    expect((await readdir(dir)).sort()).toEqual([
      '.git',
      '.gitattributes',
      '.gitignore',
      '.vnstudio',
      'project.yaml',
      'scenes',
    ]);
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

  // Opening a scratch directory inside a checkout of this monorepo really did file two commits
  // onto its master, which is how this test came to exist.
  it('scaffolds into a project inside a foreign repo without writing its history', async () => {
    await writeFile(join(root, 'notes.md'), 'the outer repo\n');
    await ensureRepo(root);
    const dir = join(root, 'inside');
    await mkdir(dir);

    expect((await openWorkspace(dir)).created).toBe(true);
    // The files belong to the project either way; only the commits are somebody else's.
    expect(await readFile(join(dir, '.gitattributes'), 'utf8')).toContain('merge=union');
    expect(await readdir(join(dir, '.vnstudio', 'layouts'))).not.toEqual([]);
    expect((await openGit(root).log()).map((c) => c.subject)).toEqual(['Existing project files']);
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

describe('createRoot', () => {
  const parent = join(tmpdir(), 'projects');

  it('leaves the chosen folder alone unless a folder was asked for', () => {
    expect(createRoot(join(parent, 'mine'), 'My Story', false)).toBe(join(parent, 'mine'));
  });

  it('names the new folder from the title, slugged', () => {
    expect(createRoot(parent, 'My First Story!', true)).toBe(join(parent, 'my_first_story'));
  });

  it('has nowhere to put a title that slugs to nothing, so it stays put', () => {
    expect(createRoot(parent, '   ', true)).toBe(parent);
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
    // The target is two levels below the repo root and neither level exists. The warning has to be
    // available before the directory is made, or its symptom has no visible cause.
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
    expect((await readdir(dir)).sort()).toEqual([
      '.git',
      '.gitattributes',
      '.gitignore',
      '.vnstudio',
      'project.yaml',
      'scenes',
      'wiki',
    ]);

    const config = await loadConfig(dir);
    expect(config).toMatchObject({ title: 'My Story', start: START_SCENE });

    // The skeleton exists so an author's first sight of a new project is not a red count.
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

  it('gets a repository of its own even inside one that already owns the path', async () => {
    await writeFile(join(root, 'notes.md'), 'the outer repo\n');
    await ensureRepo(root);

    const dir = join(root, 'projects', 'mine');
    await createWorkspace(dir, 'Mine');

    // The command promises a git repository, so the answer for the project is the project's own
    // repo — not the enclosing one, which is what makes `Workspace.repos()` call it owned.
    expect(await openGit(dir).topLevel()).toBe((await realpath(dir)).replace(/\\/g, '/'));
    expect((await openGit(dir).log()).map((c) => c.subject)).toEqual(['New project']);
    expect((await openGit(root).log()).map((c) => c.subject)).toEqual(['Existing project files']);
  }, 20_000);

  it('refuses a directory with files in it rather than merging into it', async () => {
    const dir = join(root, 'theirs');
    await mkdir(dir);
    await writeFile(join(dir, 'notes.md'), 'not mine to touch\n');

    await expect(createWorkspace(dir, 'Theirs')).rejects.toThrow('not empty');
    expect(await readdir(dir)).toEqual(['notes.md']);
  });
});

describe('ensureGitAttributes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-attrs-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const line = 'vngen/state/notifications.jsonl merge=union';

  it('writes the union-merge attribute where there is no file', async () => {
    expect(await ensureGitAttributes(root)).toBe(true);
    expect(await readFile(join(root, '.gitattributes'), 'utf8')).toContain(line);
  });

  it('appends to what the author already wrote, keeping it', async () => {
    await writeFile(join(root, '.gitattributes'), '*.png binary\n');
    expect(await ensureGitAttributes(root)).toBe(true);

    const text = await readFile(join(root, '.gitattributes'), 'utf8');
    expect(text).toContain('*.png binary');
    expect(text).toContain(line);
  });

  it('separates itself from a file with no trailing newline', async () => {
    await writeFile(join(root, '.gitattributes'), '*.png binary');
    await ensureGitAttributes(root);
    expect(await readFile(join(root, '.gitattributes'), 'utf8')).toContain('*.png binary\n#');
  });

  it('gives a project that has only the older attribute the newer one', async () => {
    await writeFile(join(root, '.gitattributes'), `${line}\n`);
    expect(await ensureGitAttributes(root)).toBe(true);

    const text = await readFile(join(root, '.gitattributes'), 'utf8');
    expect(text.split(line)).toHaveLength(2);
    expect(text).toContain('vngen/state/threads/*.native.jsonl -merge');
  });

  // A graph document is nstructjs JSON, so a textual merge of one deserializes into a graph
  // nobody authored. The block has to arrive once and stay once, however often the app runs.
  it('refuses to merge a generation graph, and says so exactly once', async () => {
    await writeFile(join(root, '.gitattributes'), `${line}\n`);
    await ensureGitAttributes(root);
    await ensureGitAttributes(root);

    const text = await readFile(join(root, '.gitattributes'), 'utf8');
    expect(text.match(/vngen\/work\/graphs\/\*\.json -merge/g)).toHaveLength(1);
    expect(text.match(/vngen\/work\/graphs\/lib\/\*\.json -merge/g)).toHaveLength(1);
  });

  it('says no and writes nothing the second time', async () => {
    await ensureGitAttributes(root);
    const before = await readFile(join(root, '.gitattributes'), 'utf8');

    expect(await ensureGitAttributes(root)).toBe(false);
    expect(await readFile(join(root, '.gitattributes'), 'utf8')).toBe(before);
  });

  it('reaches a project created before the attribute existed, on open', async () => {
    await writeFile(join(root, 'project.yaml'), 'title: "Older"\n');
    await ensureRepo(root);
    await rm(join(root, '.gitattributes'), { force: true });

    await openWorkspace(root);
    expect(await readFile(join(root, '.gitattributes'), 'utf8')).toContain(line);
  }, 20_000);
});

// The boot path never calls `openWorkspace` — it resolves a root from the recents list and goes
// straight to the repos — so this pair is what reaches a reopened project.
describe('scaffolding', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-scaffold-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  /** A project committed before this app scaffolded anything, which is what the pair is for. */
  async function olderProject(dir: string): Promise<void> {
    await writeFile(join(dir, 'project.yaml'), 'title: "Older"\n');
    await writeFile(join(dir, '.gitignore'), 'keys\n');
    const git = openGit(dir);
    await git.init();
    await git.config('user.email', 'test@localhost');
    await git.config('user.name', 'Test');
    await git.commit({ message: 'Existing project files', paths: ['-A'] });
  }

  it('writes each file on its own commit, leaving nothing for the open-time checkpoint', async () => {
    await olderProject(root);

    const wrote = await writeScaffolding(root);
    expect(wrote.attributes).toBe(true);
    expect(wrote.ignores).toBe(true);
    expect(wrote.layouts.length).toBeGreaterThan(0);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain(SESSION_IGNORE);

    await commitScaffolding(root, wrote);
    const git = openGit(root);
    expect((await git.log()).map((c) => c.subject)).toEqual([
      'Ignore the remembered window arrangement',
      'Add the shipped layout templates',
      'Set how git merges the state logs',
      'Existing project files',
    ]);
    expect((await git.status()).dirty).toBe(false);
  }, 20_000);

  it('writes the files but no commit when the project sits inside a foreign repo', async () => {
    await ensureRepo(root);
    const dir = join(root, 'inside');
    await mkdir(dir);
    await writeFile(join(dir, 'project.yaml'), 'title: "Nested"\n');

    await commitScaffolding(dir, await writeScaffolding(dir));
    expect(await readFile(join(dir, '.gitattributes'), 'utf8')).toContain(
      'vngen/state/notifications.jsonl merge=union',
    );
    expect((await openGit(root).log()).map((c) => c.subject)).toEqual(['Existing project files']);
  }, 20_000);

  it('writes nothing and commits nothing the second time', async () => {
    await olderProject(root);
    await commitScaffolding(root, await writeScaffolding(root));
    const before = await openGit(root).log();

    const again = await writeScaffolding(root);
    expect(again).toEqual({ attributes: false, ignores: false, layouts: [] });
    await commitScaffolding(root, again);
    expect(await openGit(root).log()).toEqual(before);
  }, 20_000);

  // Every pane drag rewrites the session file, so a snapshot that saw it would make the next
  // undo refuse as drift. The `.tmp-` sibling beside it is a write in progress, not a document.
  it('snapshots a scaffolded project that has written its session file', async () => {
    await olderProject(root);
    await commitScaffolding(root, await writeScaffolding(root));
    await mkdir(join(root, '.vnstudio'), { recursive: true });
    await mkdir(join(root, 'keys'), { recursive: true });
    await mkdir(join(root, 'vngen', 'build', 'assets'), { recursive: true });
    await writeFile(join(root, '.vnstudio', 'session.json'), '{"pathux.windows":[0]}\n');
    await writeFile(join(root, '.vnstudio', 'session.json.tmp-ab12'), '{}\n');
    await writeFile(join(root, 'keys', 'gemini'), 'not-a-real-key\n');

    const journal = new UndoJournal({ root, exclude: UNDO_EXCLUDES });
    const pre = await journal.capture(1);
    expect(pre).not.toBeNull();

    // A later pane drag is not workspace drift: the snapshot never saw the file to begin with,
    // and neither the generated tree nor the key beside it is in it either.
    await writeFile(join(root, '.vnstudio', 'session.json'), '{"pathux.windows":[0,1]}\n');
    await writeFile(join(root, 'vngen', 'build', 'assets', 'cafe1234.png'), 'more output');
    await writeFile(join(root, 'keys', 'gemini'), 'a-different-key\n');
    const post = await journal.capture(1);
    expect(post).toBe(pre);
    expect(await journal.check(journal.point(pre!, post!), 'post')).toMatchObject({ ok: true });
  }, 20_000);
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
