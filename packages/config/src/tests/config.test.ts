import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  keyStatus,
  keysPresent,
  loadConfig,
  missingRouteError,
  resolveKeys,
  secretDirsFor,
  setArtStyle,
  setBuiltinSkills,
  setImageModel,
  setTextModel,
  setVisionModels,
  setBubbleNames,
  setLettering,
  setShotForm,
  setStartScene,
  setStoryboardNotes,
  userConfigDir,
  userConfigDirs,
  userKeysDir,
  userSkillsDir,
  userSkillsDirs,
  withArtStyle,
  withBuiltinSkills,
  withConfigKey,
  withImageModel,
  withModelsKey,
  withStartScene,
} from '../index.js';

async function tempProject(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vn-config-'));
  await writeFile(join(dir, 'project.yaml'), yaml);
  return dir;
}

describe('loadConfig', () => {
  it('applies defaults for a minimal config', async () => {
    const dir = await tempProject('title: My Novel\n');
    const config = await loadConfig(dir);
    expect(config.title).toBe('My Novel');
    expect(config.models.image).toBe('gemini-2.5-flash-image');
    expect(config.concurrency).toBe(4);
    expect(config.max_refine_attempts).toBe(4);
    expect(config.max_task_attempts).toBe(2);
    expect(config.portrait_overlay).toBe(false);
    expect(config.start).toBeUndefined();
  });

  it('reads the entry scene from start:', async () => {
    const dir = await tempProject('title: My Novel\nstart: arrival\n');
    expect((await loadConfig(dir)).start).toBe('arrival');
  });

  it('throws ConfigError on a missing title', async () => {
    const dir = await tempProject('art_style: watercolor\n');
    await expect(loadConfig(dir)).rejects.toThrow(/invalid project\.yaml/);
  });

  it('throws ConfigError when project.yaml is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vn-config-empty-'));
    await expect(loadConfig(dir)).rejects.toThrow(/no project\.yaml/);
  });
});

describe('withStartScene', () => {
  it('adds start: under the title and leaves comments alone', () => {
    const before = '# my novel\ntitle: My Novel\n\n# how it looks\nart_style: watercolor\n';
    expect(withStartScene(before, 'arrival')).toBe(
      '# my novel\ntitle: My Novel\nstart: arrival\n\n# how it looks\nart_style: watercolor\n',
    );
  });

  it('replaces an existing start: in place', () => {
    expect(withStartScene('title: T\nstart: old\nconcurrency: 2\n', 'new')).toBe(
      'title: T\nstart: new\nconcurrency: 2\n',
    );
  });

  it('appends when there is no title to sit under', () => {
    expect(withStartScene('art_style: ink', 'arrival')).toBe('art_style: ink\nstart: arrival\n');
    expect(withStartScene('', 'arrival')).toBe('start: arrival\n');
  });
});

describe('setStartScene', () => {
  it('writes the entry scene and reads back through loadConfig', async () => {
    const dir = await tempProject('title: My Novel\nart_style: watercolor\n');
    expect(await setStartScene(dir, 'arrival')).toBe(true);
    expect((await loadConfig(dir)).start).toBe('arrival');
    expect(await readFile(join(dir, 'project.yaml'), 'utf8')).toBe(
      'title: My Novel\nstart: arrival\nart_style: watercolor\n',
    );
  });

  it('leaves a config that already names that scene untouched', async () => {
    const dir = await tempProject('title: My Novel\nstart: arrival\n');
    expect(await setStartScene(dir, 'arrival')).toBe(false);
  });

  // A scene id is a filename stem, so it can be `1.2` or `true`, which YAML reads as a number and
  // a bool unless the serializer quotes them. The property under test is that an id reads back
  // exactly as it was written
  it('keeps an id YAML would otherwise read as something else a string', async () => {
    for (const id of ['1.2', 'true', 'no', '0755']) {
      const dir = await tempProject('title: T\n');
      expect(await setStartScene(dir, id)).toBe(true);
      expect((await loadConfig(dir)).start).toBe(id);
    }
  });
});

describe('withArtStyle', () => {
  it('replaces the value in place and leaves every other byte alone', () => {
    const before = '# my novel\ntitle: T\nart_style: watercolor\nconcurrency: 2\n';
    expect(withArtStyle(before, 'ink wash')).toBe(
      '# my novel\ntitle: T\nart_style: ink wash\nconcurrency: 2\n',
    );
  });

  it('replaces a block scalar entirely, indented lines included', () => {
    const before = 'title: T\nart_style: |\n  soft anime,\n  cel shaded\nconcurrency: 2\n';
    expect(withArtStyle(before, 'ink')).toBe('title: T\nart_style: ink\nconcurrency: 2\n');
  });

  it('leaves the blank line an author put before the next key', () => {
    const before = 'title: T\nart_style: ink\n\n# how it runs\nconcurrency: 2\n';
    expect(withArtStyle(before, 'wash')).toBe(
      'title: T\nart_style: wash\n\n# how it runs\nconcurrency: 2\n',
    );
  });

  it('adds it under the title, or appends when there is none', () => {
    expect(withArtStyle('title: T\nconcurrency: 2\n', 'ink')).toBe(
      'title: T\nart_style: ink\nconcurrency: 2\n',
    );
    expect(withArtStyle('', 'ink')).toBe('art_style: ink\n');
  });
});

describe('setArtStyle', () => {
  it('writes the style and reads back through loadConfig', async () => {
    const dir = await tempProject('title: My Novel\nart_style: watercolor\n');
    expect(await setArtStyle(dir, 'ink wash, muted')).toBe(true);
    expect((await loadConfig(dir)).art_style).toBe('ink wash, muted');
    expect(await readFile(join(dir, 'project.yaml'), 'utf8')).toBe(
      'title: My Novel\nart_style: ink wash, muted\n',
    );
  });

  it('leaves a config that already says that untouched', async () => {
    const dir = await tempProject('title: T\nart_style: ink\n');
    expect(await setArtStyle(dir, 'ink')).toBe(false);
  });

  // Prose carries colons, hashes and newlines. The serializer quotes a style that would otherwise
  // re-read as a mapping or a comment
  it('survives prose YAML would otherwise re-read as structure', async () => {
    for (const style of ['soft anime: cel shaded', '# not a comment', 'two\nlines']) {
      const dir = await tempProject('title: T\nconcurrency: 2\n');
      await setArtStyle(dir, style);
      expect((await loadConfig(dir)).art_style).toBe(style);
      expect((await loadConfig(dir)).concurrency).toBe(2);
    }
  });
});

describe('withConfigKey', () => {
  it('splices whichever key it is given, and never another that shares a suffix', () => {
    const before = 'title: T\nart_style: ink\nstoryboard_notes: pages\n';
    expect(withConfigKey(before, 'storyboard_notes', 'splash per scene')).toBe(
      'title: T\nart_style: ink\nstoryboard_notes: splash per scene\n',
    );
    expect(withConfigKey(before, 'lettering', 'runner')).toBe(
      'title: T\nlettering: runner\nart_style: ink\nstoryboard_notes: pages\n',
    );
  });

  it('writes a flag as a bare boolean', () => {
    expect(withConfigKey('title: T\nbubble_names: false\n', 'bubble_names', true)).toBe(
      'title: T\nbubble_names: true\n',
    );
  });
});

describe('setStoryboardNotes and setLettering', () => {
  it('write their keys and read back through loadConfig, defaults untouched', async () => {
    const dir = await tempProject('title: T\nart_style: ink\n');
    expect(await setStoryboardNotes(dir, 'manga pages of four to six panels')).toBe(true);
    expect(await setLettering(dir, 'runner')).toBe(true);
    const config = await loadConfig(dir);
    expect(config.storyboard_notes).toBe('manga pages of four to six panels');
    expect(config.lettering).toBe('runner');
    expect(config.art_style).toBe('ink');
    expect(config.image_params.page_aspect).toBe('3:4');
  });

  it('leave a config that already says that untouched', async () => {
    const dir = await tempProject('title: T\nlettering: runner\nstoryboard_notes: pages\n');
    expect(await setLettering(dir, 'runner')).toBe(false);
    expect(await setStoryboardNotes(dir, 'pages')).toBe(false);
  });

  it('write bubble_names and read it back', async () => {
    const dir = await tempProject('title: T\n');
    expect(await setBubbleNames(dir, true)).toBe(true);
    expect((await loadConfig(dir)).bubble_names).toBe(true);
    expect(await setBubbleNames(dir, true)).toBe(false);
    expect(await setBubbleNames(dir, false)).toBe(true);
    expect((await loadConfig(dir)).bubble_names).toBe(false);
  });

  it('write shot_form and refuse a form the schema does not know', async () => {
    const dir = await tempProject('title: T\n');
    expect(await setShotForm(dir, 'pages')).toBe(true);
    expect((await loadConfig(dir)).shot_form).toBe('pages');
    expect(await setShotForm(dir, 'pages')).toBe(false);
    await expect(setShotForm(dir, 'strips' as never)).rejects.toThrow(/could not set shot_form/);
    expect((await loadConfig(dir)).shot_form).toBe('pages');
  });

  it('refuse a lettering mode the schema does not know, and write nothing', async () => {
    const dir = await tempProject('title: T\n');
    await expect(setLettering(dir, 'stencil' as never)).rejects.toThrow(/could not set lettering/);
    expect(await readFile(join(dir, 'project.yaml'), 'utf8')).toBe('title: T\n');
  });
});

describe('withBuiltinSkills', () => {
  it('replaces an indented list, row for row, leaving the keys around it alone', () => {
    const before = 'title: T\nbuiltin_skills:\n  - branching\n  - new-character\nconcurrency: 2\n';
    expect(withBuiltinSkills(before, ['full-production'])).toBe(
      'title: T\nbuiltin_skills:\n  - full-production\nconcurrency: 2\n',
    );
  });

  it('replaces rows written at the header column, which YAML also allows', () => {
    const before = 'title: T\nbuiltin_skills:\n- branching\n- new-character\nconcurrency: 2\n';
    expect(withBuiltinSkills(before, ['branching'])).toBe(
      'title: T\nbuiltin_skills:\n  - branching\nconcurrency: 2\n',
    );
  });

  it('replaces a flow-form list and writes an empty one in flow form', () => {
    expect(withBuiltinSkills('title: T\nbuiltin_skills: [branching]\nart_style: ink\n', [])).toBe(
      'title: T\nbuiltin_skills: []\nart_style: ink\n',
    );
  });

  it('adds the key after the title when the file has none', () => {
    expect(withBuiltinSkills('title: T\nart_style: ink\n', ['branching'])).toBe(
      'title: T\nbuiltin_skills:\n  - branching\nart_style: ink\n',
    );
  });

  it('keeps a blank line that separates the list from the next key', () => {
    const before = 'title: T\nbuiltin_skills:\n  - branching\n\nconcurrency: 2\n';
    expect(withBuiltinSkills(before, ['new-character'])).toBe(
      'title: T\nbuiltin_skills:\n  - new-character\n\nconcurrency: 2\n',
    );
  });
});

describe('setBuiltinSkills', () => {
  it('writes the list, and a file without the key reads back as every skill enabled', async () => {
    const dir = await tempProject('title: T\n');
    expect((await loadConfig(dir)).builtin_skills).toEqual([
      'branching',
      'full-production',
      'new-character',
    ]);
    expect(await setBuiltinSkills(dir, ['branching'])).toBe(true);
    expect((await loadConfig(dir)).builtin_skills).toEqual(['branching']);
    expect(await setBuiltinSkills(dir, [])).toBe(true);
    expect((await loadConfig(dir)).builtin_skills).toEqual([]);
  });

  it('leaves a config that already lists those ids untouched', async () => {
    const dir = await tempProject('title: T\nbuiltin_skills:\n  - branching\n');
    expect(await setBuiltinSkills(dir, ['branching'])).toBe(false);
  });

  it('writes an id the catalog does not have: filtering is the reader’s job', async () => {
    const dir = await tempProject('title: T\n');
    expect(await setBuiltinSkills(dir, ['branching', 'retired-skill'])).toBe(true);
    expect((await loadConfig(dir)).builtin_skills).toEqual(['branching', 'retired-skill']);
  });
});

describe('userSkillsDir', () => {
  it('sits beside keys under the user config directory, and lists in userConfigDirs order', () => {
    const opts = { env: { VNAUTHOR_HOME: 'C:\\cfg' } };
    expect(userSkillsDir(opts)).toBe(join(userConfigDir(opts), 'skills'));
    expect(userSkillsDirs(opts)).toEqual(userConfigDirs(opts).map((dir) => join(dir, 'skills')));
  });
});

describe('withImageModel', () => {
  it('replaces the image row inside an existing models block, at its own indent', () => {
    const before =
      'title: T\nmodels:\n    text: claude-opus-4-8\n    image: gemini-2.5-flash-image # default\n    vision:\n      - gemini-2.5-pro\nconcurrency: 2\n';
    expect(withImageModel(before, 'openai/gpt-image-2')).toBe(
      'title: T\nmodels:\n    text: claude-opus-4-8\n    image: openai/gpt-image-2\n    vision:\n      - gemini-2.5-pro\nconcurrency: 2\n',
    );
  });

  it('adds the row as the first line of a models block that has none', () => {
    const before = 'title: T\nmodels:\n  text: claude-opus-4-8\n\n  vision: []\nconcurrency: 2\n';
    expect(withImageModel(before, 'bfl/flux-2')).toBe(
      'title: T\nmodels:\n  image: bfl/flux-2\n  text: claude-opus-4-8\n\n  vision: []\nconcurrency: 2\n',
    );
  });

  it('adds a models block after the title when the file has none', () => {
    expect(withImageModel('title: T\nconcurrency: 2\n', 'bfl/flux-2')).toBe(
      'title: T\nmodels:\n  image: bfl/flux-2\nconcurrency: 2\n',
    );
    expect(withImageModel('', 'bfl/flux-2')).toBe('models:\n  image: bfl/flux-2\n');
  });

  it('never touches an image key at the top level or in another block', () => {
    const before =
      'title: T\nimage: not-this\nimage_params:\n  image: nor-this\nmodels:\n  image: old\n';
    expect(withImageModel(before, 'new')).toBe(
      'title: T\nimage: not-this\nimage_params:\n  image: nor-this\nmodels:\n  image: new\n',
    );
  });

  it('keeps an unterminated last line unterminated', () => {
    expect(withImageModel('title: T\nmodels:\n  image: old', 'new')).toBe(
      'title: T\nmodels:\n  image: new',
    );
    expect(withImageModel('title: T\nmodels:', 'new')).toBe('title: T\nmodels:\n  image: new');
  });
});

describe('withModelsKey', () => {
  it('replaces a list row and every line indented under it', () => {
    const before =
      'title: T\nmodels:\n  text: claude-opus-4-8\n  vision:\n    - gemini-2.5-pro\n    - claude-opus-4-8\n  image: x\nconcurrency: 2\n';
    expect(withModelsKey(before, 'vision', ['gemini-2.5-flash'])).toBe(
      'title: T\nmodels:\n  text: claude-opus-4-8\n  vision:\n    - gemini-2.5-flash\n  image: x\nconcurrency: 2\n',
    );
  });

  it('replaces a scalar row with a list, and a list with an empty flow list', () => {
    expect(withModelsKey('models:\n  vision: []\n  text: old\n', 'text', 'new')).toBe(
      'models:\n  vision: []\n  text: new\n',
    );
    expect(withModelsKey('models:\n  vision:\n    - a\n  text: old\n', 'vision', [])).toBe(
      'models:\n  vision: []\n  text: old\n',
    );
  });

  it('adds a list row to a block that has none, at the block indent', () => {
    expect(withModelsKey('title: T\nmodels:\n    text: t\n', 'vision', ['a', 'b'])).toBe(
      'title: T\nmodels:\n    vision:\n      - a\n      - b\n    text: t\n',
    );
  });
});

describe('setTextModel and setVisionModels', () => {
  it('write their keys and read back through loadConfig', async () => {
    const dir = await tempProject('title: T\nmodels:\n  image: bfl/flux-2\n');
    expect(await setTextModel(dir, 'gemini-2.5-pro')).toBe(true);
    expect(await setVisionModels(dir, ['gemini-2.5-flash'])).toBe(true);
    const config = await loadConfig(dir);
    expect(config.models).toEqual({
      image : 'bfl/flux-2',
      text  : 'gemini-2.5-pro',
      vision: ['gemini-2.5-flash'],
    });
    expect(await setVisionModels(dir, ['gemini-2.5-flash'])).toBe(false);
    expect(await setTextModel(dir, 'gemini-2.5-pro')).toBe(false);
  });
});

describe('setImageModel', () => {
  it('writes the model and reads back through loadConfig', async () => {
    const dir = await tempProject('title: T\nmodels:\n  text: claude-opus-4-8\n');
    expect(await setImageModel(dir, 'openai/gpt-image-2')).toBe(true);
    const config = await loadConfig(dir);
    expect(config.models.image).toBe('openai/gpt-image-2');
    expect(config.models.text).toBe('claude-opus-4-8');
  });

  it('leaves a config that already says that untouched', async () => {
    const dir = await tempProject('title: T\nmodels:\n  image: bfl/flux-2\n');
    expect(await setImageModel(dir, 'bfl/flux-2')).toBe(false);
  });

  it('refuses a models block it cannot place a row in, and writes nothing', async () => {
    const dir = await tempProject('title: T\nmodels: {}\n');
    await expect(setImageModel(dir, 'bfl/flux-2')).rejects.toThrow(/could not set models.image/);
    expect(await readFile(join(dir, 'project.yaml'), 'utf8')).toBe('title: T\nmodels: {}\n');
  });
});

describe('loadConfig — the storyboard keys', () => {
  it('defaults storyboard_notes to nothing, lettering to the runner and page_aspect to 3:4', async () => {
    const config = await loadConfig(await tempProject('title: T\n'));
    expect(config.storyboard_notes).toBe('');
    expect(config.lettering).toBe('runner');
    expect(config.image_params.page_aspect).toBe('3:4');
  });

  it('refuses a page_aspect that is not two whole numbers', async () => {
    const dir = await tempProject('title: T\nimage_params:\n  page_aspect: tall\n');
    await expect(loadConfig(dir)).rejects.toThrow(/page_aspect/);
  });
});

describe('resolveKeys', () => {
  it('reads keys from the environment first', async () => {
    const dir = await tempProject('title: T\n');
    const config = await loadConfig(dir);
    process.env['GEMINI_API_KEY'] = 'env-gemini';
    process.env['ANTHROPIC_API_KEY'] = 'env-anthropic';
    try {
      const keys = await resolveKeys(config, { require: ['gemini', 'anthropic'] });
      expect(keys.gemini).toBe('env-gemini');
      expect(keys.anthropic).toBe('env-anthropic');
    } finally {
      delete process.env['GEMINI_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('falls back to secret files', async () => {
    const dir = await tempProject('title: T\n');
    const config = await loadConfig(dir);
    const secrets = join(dir, 'keys');
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, 'gemini.txt'), 'file-gemini\n');
    await writeFile(join(secrets, 'claude.txt'), 'file-claude\n');
    const keys = await resolveKeys(config, {
      secretsDirs: [secrets],
      require    : ['gemini', 'anthropic'],
    });
    expect(keys.gemini).toBe('file-gemini');
    expect(keys.anthropic).toBe('file-claude');
  });

  it('consults secret dirs in order, preferring the first', async () => {
    const dir = await tempProject('title: T\n');
    const config = await loadConfig(dir);
    const projectKeys = join(dir, 'keys');
    const rootKeys = join(dir, 'root-keys');
    await mkdir(projectKeys, { recursive: true });
    await mkdir(rootKeys, { recursive: true });
    // gemini at both levels so the project's copy wins; anthropic only at the shared root
    await writeFile(join(projectKeys, 'gemini.txt'), 'project-gemini\n');
    await writeFile(join(rootKeys, 'gemini.txt'), 'root-gemini\n');
    await writeFile(join(rootKeys, 'claude.txt'), 'root-claude\n');
    const keys = await resolveKeys(config, {
      secretsDirs: [projectKeys, rootKeys],
      require    : ['gemini', 'anthropic'],
    });
    expect(keys.gemini).toBe('project-gemini');
    expect(keys.anthropic).toBe('root-claude');
  });
});

describe('secretDirsFor', () => {
  it("includes the project's keys/, the repo root's, then the user's", async () => {
    const root = await mkdtemp(join(tmpdir(), 'vn-repo-'));
    await mkdir(join(root, '.git'), { recursive: true });
    const project = join(root, 'templates', 'basic');
    await mkdir(project, { recursive: true });
    const dirs = await secretDirsFor(project);
    expect(dirs).toEqual([join(project, 'keys'), join(root, 'keys'), userKeysDir()]);
  });

  it('de-duplicates when the project is itself the repo root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vn-repo-root-'));
    await mkdir(join(root, '.git'), { recursive: true });
    const dirs = await secretDirsFor(root);
    expect(dirs).toEqual([join(root, 'keys'), userKeysDir()]);
  });

  it('omits the user rung when asked to — the opt-out testkit relies on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vn-repo-closed-'));
    await mkdir(join(root, '.git'), { recursive: true });
    const dirs = await secretDirsFor(root, { includeUser: false });
    expect(dirs).toEqual([join(root, 'keys')]);
  });

  it('the user rung is last, so a project that carries a key still wins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vn-userhome-'));
    await mkdir(join(home, 'keys'), { recursive: true });
    await writeFile(join(home, 'keys', 'gemini.txt'), 'user-gemini\n');

    const project = await tempProject('title: T\n');
    await mkdir(join(project, 'keys'), { recursive: true });
    await writeFile(join(project, 'keys', 'gemini.txt'), 'project-gemini\n');
    await writeFile(join(project, 'keys', 'claude.txt'), '');

    const config = await loadConfig(project);
    const secretsDirs = await secretDirsFor(project, { env: { VNAUTHOR_HOME: home } });
    const keys = await resolveKeys(config, { secretsDirs });
    expect(keys.gemini).toBe('project-gemini');
    // the user rung does answer when the project carries nothing
    await writeFile(join(home, 'keys', 'claude.txt'), 'user-claude\n');
    expect((await resolveKeys(config, { secretsDirs })).anthropic).toBe('user-claude');
  });
});

describe('userConfigDir', () => {
  const HOME = join('/tmp', 'home', 'someone');

  it('is %LOCALAPPDATA%\\vnauthor on Windows', () => {
    const env = { LOCALAPPDATA: join('C:', 'Users', 'someone', 'AppData', 'Local') };
    expect(userConfigDir({ platform: 'win32', env, home: HOME })).toBe(
      join(env.LOCALAPPDATA, 'vnauthor'),
    );
  });

  it('falls back to AppData\\Local under the home directory when the variable is unset', () => {
    expect(userConfigDir({ platform: 'win32', env: {}, home: HOME })).toBe(
      join(HOME, 'AppData', 'Local', 'vnauthor'),
    );
  });

  it('is Application Support on macOS', () => {
    expect(userConfigDir({ platform: 'darwin', env: {}, home: HOME })).toBe(
      join(HOME, 'Library', 'Application Support', 'vnauthor'),
    );
  });

  it('honours $XDG_CONFIG_HOME on Linux, else ~/.config', () => {
    const xdg = join('/tmp', 'xdg');
    expect(userConfigDir({ platform: 'linux', env: { XDG_CONFIG_HOME: xdg }, home: HOME })).toBe(
      join(xdg, 'vnauthor'),
    );
    expect(userConfigDir({ platform: 'linux', env: {}, home: HOME })).toBe(
      join(HOME, '.config', 'vnauthor'),
    );
  });

  it('$VNAUTHOR_HOME overrides every platform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vn-override-'));
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(userConfigDir({ platform, env: { VNAUTHOR_HOME: dir }, home: HOME })).toBe(dir);
    }
  });

  it('reads a legacy ~/.vnauthor when the native directory does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vn-legacy-'));
    await mkdir(join(home, '.vnauthor'), { recursive: true });
    const dirs = userConfigDirs({ platform: 'linux', env: {}, home });
    expect(dirs).toEqual([join(home, '.config', 'vnauthor'), join(home, '.vnauthor')]);
    // the legacy directory is never the write target, so nothing has to be migrated later
    expect(userConfigDir({ platform: 'linux', env: {}, home })).toBe(
      join(home, '.config', 'vnauthor'),
    );
  });

  it('an explicit $VNAUTHOR_HOME suppresses the legacy fallback rather than preceding it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vn-legacy-off-'));
    await mkdir(join(home, '.vnauthor'), { recursive: true });
    const override = join(home, 'elsewhere');
    expect(userConfigDirs({ platform: 'linux', env: { VNAUTHOR_HOME: override }, home })).toEqual([
      override,
    ]);
  });
});

describe('keyStatus', () => {
  it('names the source that answered, and never the value', async () => {
    const dir = await tempProject('title: T\n');
    await mkdir(join(dir, 'keys'), { recursive: true });
    await writeFile(join(dir, 'keys', 'gemini.txt'), 'sekrit\n');
    const config = await loadConfig(dir);

    const status = await keyStatus(config, { secretsDirs: [join(dir, 'keys')] });
    expect(status.map((s) => s.vendor)).toEqual(['gemini', 'anthropic', 'openrouter']);

    const gemini = status[0]!;
    expect(gemini.resolved).toBe(true);
    expect(gemini.source).toEqual({ kind: 'file', dir: join(dir, 'keys'), file: 'gemini.txt' });
    expect(gemini.envShadow).toBe(false);
    expect(JSON.stringify(status)).not.toContain('sekrit');

    expect(status[1]!.resolved).toBe(false);
    expect(status[1]!.source).toBeUndefined();
    expect(status[1]!.envName).toBe(config.keys.anthropic);
  });

  it('reports an environment variable as the source, and as a shadow over a file', async () => {
    const dir = await tempProject('title: T\nkeys:\n  gemini: VN_TEST_GEMINI_KEY\n');
    await mkdir(join(dir, 'keys'), { recursive: true });
    await writeFile(join(dir, 'keys', 'gemini.txt'), 'from-file\n');
    process.env.VN_TEST_GEMINI_KEY = 'from-env';
    try {
      const config = await loadConfig(dir);
      const [gemini] = await keyStatus(config, { secretsDirs: [join(dir, 'keys')] });
      expect(gemini!.source).toEqual({ kind: 'env', name: 'VN_TEST_GEMINI_KEY' });
      expect(gemini!.envShadow).toBe(true);
    } finally {
      delete process.env.VN_TEST_GEMINI_KEY;
    }
  });
});

describe('resolveKeys errors', () => {
  it('throws when a required key is missing, without leaking values', async () => {
    const dir = await tempProject('title: T\n');
    const config = await loadConfig(dir);
    await expect(resolveKeys(config, { require: ['gemini'] })).rejects.toThrow(
      /missing gemini API key/,
    );
  });

  it('resolves every vendor, naming the openrouter file and env var when that one is required', async () => {
    const dir = await tempProject('title: T\n');
    await mkdir(join(dir, 'keys'), { recursive: true });
    await writeFile(join(dir, 'keys', 'openrouter.txt'), 'or-key\n');
    const config = await loadConfig(dir);
    const keys = await resolveKeys(config, { secretsDirs: [join(dir, 'keys')] });
    expect(keys).toEqual({ gemini: '', anthropic: '', openrouter: 'or-key' });

    const bare = await loadConfig(await tempProject('title: T\n'));
    await expect(resolveKeys(bare, { require: ['openrouter'] })).rejects.toThrow(
      /missing openrouter API key: set \$OPENROUTER_API_KEY or place openrouter\.txt/,
    );
  });
});

describe('keysPresent and missingRouteError', () => {
  it('reduces resolved keys to booleans, treating whitespace as absent', () => {
    expect(keysPresent({ gemini: 'g', anthropic: ' ', openrouter: '' })).toEqual({
      gemini    : true,
      anthropic : false,
      openrouter: false,
    });
  });

  it('names both ways out for a model OpenRouter can carry', async () => {
    const config = await loadConfig(await tempProject('title: T\n'));
    expect(missingRouteError(config, 'claude-opus-4-8', 'anthropic').message).toBe(
      'missing anthropic API key for claude-opus-4-8: set $ANTHROPIC_API_KEY or place claude.txt in a keys/ dir, or set $OPENROUTER_API_KEY to route it through OpenRouter',
    );
  });

  it('names one key for an id spelled for OpenRouter, or one OpenRouter cannot spell', async () => {
    const config = await loadConfig(await tempProject('title: T\n'));
    expect(missingRouteError(config, 'openai/gpt-image-2', 'openrouter').message).toBe(
      'missing openrouter API key for openai/gpt-image-2: set $OPENROUTER_API_KEY or place openrouter.txt in a keys/ dir',
    );
    expect(missingRouteError(config, 'some-local-model', 'gemini').message).toBe(
      'missing gemini API key for some-local-model: set $GEMINI_API_KEY or place gemini.txt in a keys/ dir',
    );
  });
});
