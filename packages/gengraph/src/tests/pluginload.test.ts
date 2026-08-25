import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as esbuild from 'esbuild';

import { genNodeRuntime, genNodeSpec } from '../registry.js';
import {
  activateGenPlugin,
  activateInstalledPlugins,
  esbuildPluginBundler,
  pluginBuildDir,
  pluginWriteRefusal,
  readGenPlugin,
  userPluginsDir,
} from '../pluginload.js';
import type { GenServices } from '../services.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const FIXTURE = join(REPO_ROOT, 'packages', 'testkit', 'src', 'plugin');

const bundle = esbuildPluginBundler(esbuild);

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gengraph-plugins-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The fixture plugin copied where a real install would put it, with `over` merged in. */
function install(name = 'testkit-shout', over: Record<string, unknown> = {}): string {
  const dir = join(userPluginsDir({ env: { VNAUTHOR_HOME: home } }), name);
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...manifest, name, ...over }, null, 2));
  return dir;
}

/** Services that record what a runtime asked for, so a run proves the capability reached it. */
function mockServices(): { services: GenServices; asked: string[] } {
  const asked: string[] = [];
  const services = {
    text: {
      async complete(modelId: string, prompt: string) {
        asked.push(`${modelId}:${prompt}`);
        return prompt.toUpperCase();
      },
    },
  } as unknown as GenServices;
  return { services, asked };
}

describe('reading an installed plugin', () => {
  it('reads the manifest and the sentence an author confirms, running nothing', async () => {
    const read = await readGenPlugin(install());
    expect(read).toMatchObject({ ok: true, manifest: { name: 'testkit-shout' } });
    if (read.ok) expect(read.confirmation).toContain('It calls text');
    expect(genNodeSpec('TestkitShout')).toBeUndefined();
  });

  it('refuses a directory holding no manifest by name', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gengraph-noplugin-'));
    const read = await readGenPlugin(empty);
    expect(read).toMatchObject({ ok: false });
    if (!read.ok) expect(read.reason).toContain('plugin.json');
    rmSync(empty, { recursive: true, force: true });
  });

  it('refuses an entry the manifest names and the directory does not hold', async () => {
    const dir = install('testkit-shout', { entry: 'missing.ts' });
    const read = await readGenPlugin(dir);
    expect(read).toMatchObject({ ok: false });
    if (!read.ok) expect(read.reason).toContain('which is not there');
  });
});

describe('activating a plugin', () => {
  it('registers the node type it declared and runs it against services', async () => {
    const result = await activateGenPlugin(install(), bundle);
    expect(result).toMatchObject({ ok: true });

    const spec = genNodeSpec('TestkitShout');
    expect(spec?.spends).toBe(true);
    expect(spec?.estimate?.({ model: 'testkit-shouter' }, { connected: new Set() })).toEqual([
      { service: 'text', model: 'testkit-shouter', unit: 'mtok-in', count: 0.0002 },
    ]);

    const run = genNodeRuntime('TestkitShout');
    const { services, asked } = mockServices();
    await expect(run?.({ text: 'quiet' }, { model: 'testkit-shouter' }, services)).resolves.toEqual(
      {
        text: 'QUIET',
      },
    );
    expect(asked).toEqual(['testkit-shouter:quiet']);
  }, 60_000);

  it('caches the bundle beside the sources and rebuilds when one changes', async () => {
    const dir = install();
    await activateGenPlugin(dir, bundle);

    const built = join(pluginBuildDir(dir), 'plugin.cjs');
    const first = readFileSync(built, 'utf8');
    const stamp = readFileSync(join(pluginBuildDir(dir), 'stamp'), 'utf8');

    let calls = 0;
    const counted = async (entry: string): Promise<string> => {
      calls++;
      return bundle(entry);
    };

    await activateGenPlugin(dir, counted);
    expect(calls).toBe(0);

    writeFileSync(
      join(dir, 'node.ts'),
      `${readFileSync(join(dir, 'node.ts'), 'utf8')}\n// edited\n`,
    );
    await activateGenPlugin(dir, counted);
    expect(calls).toBe(1);
    expect(readFileSync(join(pluginBuildDir(dir), 'stamp'), 'utf8')).not.toBe(stamp);
    expect(first.length).toBeGreaterThan(0);
  }, 60_000);

  // The registry is a single map, so a bundle carrying its own copy of the API would
  // register into one the host never reads.
  it('refuses a bundle that still names the API specifier', async () => {
    const dir = install();
    const naming = async (): Promise<string> =>
      `import {x} from '@vn/gengraph/plugin';\nexport default () => x;\n`;
    const result = await activateGenPlugin(dir, naming);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('may only import it for types');
  });

  it('refuses a node type the manifest does not declare', async () => {
    const dir = install('testkit-shout', { nodeTypes: ['SomethingElse'] });
    const result = await activateGenPlugin(dir, bundle);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('which its manifest does not declare');
  }, 60_000);
});

describe('activating everything installed', () => {
  it('reports what loaded and what refused, rather than stopping at the first refusal', async () => {
    install('testkit-shout');
    install('broken', { entry: 'missing.ts' });

    const result = await activateInstalledPlugins(bundle, { env: { VNAUTHOR_HOME: home } });
    expect(result.loaded.map((m) => m.name)).toEqual(['testkit-shout']);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toContain('which is not there');
  }, 60_000);

  it('finds nothing where no plugin has been installed', async () => {
    const result = await activateInstalledPlugins(bundle, { env: { VNAUTHOR_HOME: home } });
    expect(result).toEqual({ loaded: [], refused: [] });
  });
});

describe('the refusal the agent gets for a plugin path', () => {
  const env = (): { env: { VNAUTHOR_HOME: string } } => ({ env: { VNAUTHOR_HOME: home } });

  it('refuses the plugins root and anything under it', () => {
    expect(pluginWriteRefusal(userPluginsDir(env()), env())).toContain('installed by a person');
    expect(pluginWriteRefusal(join(userPluginsDir(env()), 'acme', 'index.ts'), env())).toBeTruthy();
  });

  it('reads a path that climbs into the plugins root as one', () => {
    const climbing = join(userPluginsDir(env()), '..', 'plugins', 'acme');
    expect(pluginWriteRefusal(climbing, env())).toBeTruthy();
  });

  it('leaves every other path alone', () => {
    expect(pluginWriteRefusal(join(home, 'keys', 'gemini'), env())).toBeNull();
    expect(pluginWriteRefusal('characters/aiko/character.md', env())).toBeNull();
    // A path whose last segment merely starts the same way is a different directory.
    expect(pluginWriteRefusal(`${userPluginsDir(env())}-old`, env())).toBeNull();
  });
});
