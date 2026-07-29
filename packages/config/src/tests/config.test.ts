import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveKeys, secretDirsFor } from '../index.js';

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
      require: ['gemini', 'anthropic'],
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
    // gemini only at the project level, anthropic only at the (shared) root level.
    await writeFile(join(projectKeys, 'gemini.txt'), 'project-gemini\n');
    await writeFile(join(rootKeys, 'gemini.txt'), 'root-gemini\n');
    await writeFile(join(rootKeys, 'claude.txt'), 'root-claude\n');
    const keys = await resolveKeys(config, {
      secretsDirs: [projectKeys, rootKeys],
      require: ['gemini', 'anthropic'],
    });
    expect(keys.gemini).toBe('project-gemini');
    expect(keys.anthropic).toBe('root-claude');
  });
});

describe('secretDirsFor', () => {
  it("includes the project's keys/ then the enclosing repo root's keys/", async () => {
    const root = await mkdtemp(join(tmpdir(), 'vn-repo-'));
    await mkdir(join(root, '.git'), { recursive: true });
    const project = join(root, 'examples', 'sample');
    await mkdir(project, { recursive: true });
    const dirs = await secretDirsFor(project);
    expect(dirs).toEqual([join(project, 'keys'), join(root, 'keys')]);
  });

  it('de-duplicates when the project is itself the repo root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vn-repo-root-'));
    await mkdir(join(root, '.git'), { recursive: true });
    const dirs = await secretDirsFor(root);
    expect(dirs).toEqual([join(root, 'keys')]);
  });

  it('throws when a required key is missing, without leaking values', async () => {
    const dir = await tempProject('title: T\n');
    const config = await loadConfig(dir);
    await expect(resolveKeys(config, { require: ['gemini'] })).rejects.toThrow(
      /missing gemini API key/,
    );
  });
});
