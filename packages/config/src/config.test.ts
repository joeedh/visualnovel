import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveKeys } from './index.js';

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
      secretsDir: secrets,
      require: ['gemini', 'anthropic'],
    });
    expect(keys.gemini).toBe('file-gemini');
    expect(keys.anthropic).toBe('file-claude');
  });

  it('throws when a required key is missing, without leaking values', async () => {
    const dir = await tempProject('title: T\n');
    const config = await loadConfig(dir);
    await expect(resolveKeys(config, { require: ['gemini'] })).rejects.toThrow(
      /missing gemini API key/,
    );
  });
});
