/**
 * Reading a plugin directory, bundling its sources and activating what comes out. The
 * bundler is supplied by the host rather than imported, so this package carries no build
 * tool and the desktop app decides which esbuild build ships with it.
 */
import { userConfigDir } from '@vn/config';
import type { UserDirEnv } from '@vn/config';
import { ensureDir, exists, join, readText, sha256, writeFileAtomic } from '@vn/util';
import { createRequire } from 'node:module';
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installDescription, parseGenPluginManifest } from './manifest.js';
import type { GenPluginManifest } from './manifest.js';
import { genPluginApi } from './plugin.js';
import type { GenPluginModule } from './plugin.js';

/** Where plugins are installed. Per-user, because installing one is a trust act by a person. */
export function userPluginsDir(opts: UserDirEnv = {}): string {
  return join(userConfigDir(opts), 'plugins');
}

export function pluginDir(name: string, opts: UserDirEnv = {}): string {
  return join(userPluginsDir(opts), name);
}

/**
 * Where a plugin's bundle is cached, beside its own sources so removing the directory
 * removes both.
 */
export function pluginBuildDir(dir: string): string {
  return join(dir, '.build');
}

/**
 * The specifier a plugin names in its imports. It must not survive into the bundle: a
 * second copy of this package would carry a second registry, and the node types a plugin
 * declared would land in maps the host never reads.
 */
export const PLUGIN_API_SPECIFIER = '@vn/gengraph/plugin';

/** The one sentence the agent's raw file writers refuse a plugin path with. */
const PLUGIN_WRITE_REFUSAL =
  "a plugin runs with this application's own permissions, so one is installed by a person " +
  'confirming what it declares, not written by an agent.';

/**
 * Non-null when a file writer must refuse this path because it lands in the plugins root.
 *
 * The path is absolute and is compared against an absolute root, because the plugins root
 * sits outside every workspace. A writer that resolved the path against a workspace first
 * would refuse it as out of bounds and never reach this sentence, so this runs before that
 * check rather than after it.
 */
export function pluginWriteRefusal(path: string, opts: UserDirEnv = {}): string | null {
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();
  const root = norm(userPluginsDir(opts));
  const target = norm(path);
  if (target === root || target.startsWith(`${root}/`)) return PLUGIN_WRITE_REFUSAL;
  return null;
}

/** Bundles one entry module into a single CommonJS source. Supplied by the host. */
export type GenPluginBundler = (entryFile: string) => Promise<string>;

/**
 * As much of esbuild as bundling a plugin needs. Declared structurally so this package
 * depends on no build tool and the host passes whichever esbuild build it ships.
 */
export interface GenEsbuild {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[] }>;
}

/**
 * Bundles a plugin with the esbuild the caller supplies. The API specifier is external, so
 * a plugin that imports it for values leaves it in the output and {@link buildGenPlugin}
 * refuses the result rather than shipping a second registry.
 */
export function esbuildPluginBundler(esbuild: GenEsbuild): GenPluginBundler {
  return async (entryFile) => {
    const built = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      // CommonJS, because the two hosts that load a plugin are both CommonJS: the desktop
      // app's main bundle, and jest, whose runtime cannot import an ES module at all.
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      // A node type is looked up by the name its class declares, and a minified class name
      // would not be the name the graph file was written with.
      keepNames: true,
      external: [PLUGIN_API_SPECIFIER],
      logLevel: 'silent',
    });
    const out = built.outputFiles?.[0];
    if (out === undefined) throw new Error('esbuild produced no output');
    return out.text;
  };
}

export type GenPluginLoad =
  | { ok: true; manifest: GenPluginManifest; confirmation: string }
  | { ok: false; reason: string };

/**
 * Reads and validates a plugin directory without running any of its code. This is what the
 * install confirmation is drawn from, so the author reads the manifest's own declarations
 * before anything is bundled.
 */
export async function readGenPlugin(dir: string): Promise<GenPluginLoad> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(join(dir, 'plugin.json')));
  } catch (err) {
    return { ok: false, reason: `${dir} holds no readable plugin.json (${String(err)})` };
  }

  const parsed = parseGenPluginManifest(raw);
  if (!parsed.ok) return parsed;

  const entry = join(dir, parsed.manifest.entry);
  if (!(await exists(entry))) {
    return {
      ok: false,
      reason: `${parsed.manifest.name} names entry "${parsed.manifest.entry}", which is not there`,
    };
  }

  return { ok: true, manifest: parsed.manifest, confirmation: installDescription(parsed.manifest) };
}

/**
 * Copies a validated plugin directory into the per-user plugins root, replacing whatever was
 * installed under that name. The caller confirms {@link readGenPlugin}'s sentence first, so
 * nothing here asks. The build cache is left behind rather than copied, because a bundle
 * built somewhere else is not what the author was shown.
 */
export async function installGenPlugin(
  source: string,
  opts: UserDirEnv = {},
): Promise<{ ok: true; manifest: GenPluginManifest; dir: string } | { ok: false; reason: string }> {
  const read = await readGenPlugin(source);
  if (!read.ok) return read;

  const dir = pluginDir(read.manifest.name, opts);
  if (resolve(source) === resolve(dir)) {
    return { ok: false, reason: `${read.manifest.name} is already installed at ${dir}` };
  }

  await ensureDir(userPluginsDir(opts));
  await rm(dir, { recursive: true, force: true });
  await cp(source, dir, {
    recursive: true,
    filter: (from) => resolve(from) !== resolve(pluginBuildDir(source)),
  });
  return { ok: true, manifest: read.manifest, dir };
}

/** Removes an installed plugin's directory. Refuses a name nothing is installed under. */
export async function removeGenPlugin(
  name: string,
  opts: UserDirEnv = {},
): Promise<{ ok: true; dir: string } | { ok: false; reason: string }> {
  const dir = pluginDir(name, opts);
  if (!(await exists(dir))) return { ok: false, reason: `no plugin called "${name}" is installed` };
  await rm(dir, { recursive: true, force: true });
  return { ok: true, dir };
}

/**
 * Reads every installed plugin's manifest, in name order, running none of their code. A
 * directory that does not read as a plugin is reported by its refusal rather than dropped.
 */
export async function readInstalledPlugins(
  opts: UserDirEnv = {},
): Promise<{ name: string; manifest?: GenPluginManifest; reason?: string }[]> {
  const root = userPluginsDir(opts);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const out: { name: string; manifest?: GenPluginManifest; reason?: string }[] = [];
  for (const name of names) {
    const read = await readGenPlugin(join(root, name));
    out.push(read.ok ? { name, manifest: read.manifest } : { name, reason: read.reason });
  }
  return out;
}

/**
 * Every source the bundle is rebuilt when any of them changes: the manifest plus each `.ts`
 * file under the plugin directory, excluding the build cache itself.
 */
async function sourceHash(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '.build') await walk(child);
      } else if (entry.name.endsWith('.ts') || entry.name === 'plugin.json') {
        files.push(child);
      }
    }
  };
  await walk('');

  const parts: string[] = [];
  for (const rel of files) {
    parts.push(rel, sha256(await readFile(join(dir, rel))));
  }
  return sha256(parts.join('\n'));
}

/**
 * Bundles the plugin unless the cached bundle was built from these same sources, and
 * returns the file the bundle sits in. A bundle that still names
 * {@link PLUGIN_API_SPECIFIER} is refused rather than cached.
 */
export async function buildGenPlugin(
  dir: string,
  manifest: GenPluginManifest,
  bundle: GenPluginBundler,
): Promise<{ ok: true; file: string } | { ok: false; reason: string }> {
  const build = pluginBuildDir(dir);
  const file = join(build, 'plugin.cjs');
  const stampFile = join(build, 'stamp');
  const stamp = await sourceHash(dir);

  if (await exists(file)) {
    const cached = await readText(stampFile).catch(() => '');
    if (cached === stamp) return { ok: true, file };
  }

  let code: string;
  try {
    code = await bundle(join(dir, manifest.entry));
  } catch (err) {
    return { ok: false, reason: `${manifest.name} did not build: ${String(err)}` };
  }

  if (code.includes(PLUGIN_API_SPECIFIER)) {
    return {
      ok: false,
      reason: `${manifest.name} imports ${PLUGIN_API_SPECIFIER} at run time, and it may only import it for types`,
    };
  }

  await ensureDir(build);
  await writeFileAtomic(file, code);
  await writeFileAtomic(stampFile, stamp);
  return { ok: true, file };
}

/**
 * Builds a plugin if needed and runs its `activate`, which is the point its node types
 * enter the registry. Every failure is named rather than thrown, because one bad plugin
 * must not stop the rest from loading.
 */
export async function activateGenPlugin(
  dir: string,
  bundle: GenPluginBundler,
): Promise<{ ok: true; manifest: GenPluginManifest } | { ok: false; reason: string }> {
  const read = await readGenPlugin(dir);
  if (!read.ok) return read;

  const built = await buildGenPlugin(dir, read.manifest, bundle);
  if (!built.ok) return built;

  let module: GenPluginModule;
  try {
    const req = createRequire(built.file);
    // Dropping the cache entry keeps a rebuilt bundle from being served out of the one the
    // previous build left behind, which is what an author gets after editing a plugin.
    delete req.cache[req.resolve(built.file)];
    module = req(built.file) as GenPluginModule;
  } catch (err) {
    return { ok: false, reason: `${read.manifest.name} could not be loaded: ${String(err)}` };
  }

  if (typeof module.default !== 'function') {
    return {
      ok: false,
      reason: `${read.manifest.name}'s entry has no default-exported activate function`,
    };
  }

  try {
    module.default(
      genPluginApi(read.manifest.name, read.manifest.nodeTypes, {
        priceAgent: read.manifest.priceAgent,
      }),
    );
  } catch (err) {
    return { ok: false, reason: `${read.manifest.name} failed while activating: ${String(err)}` };
  }

  return { ok: true, manifest: read.manifest };
}

/**
 * Activates every installed plugin, in name order. Returns what loaded and what refused, so
 * a host reports the refusals rather than leaving an author with a missing node type and no
 * explanation.
 */
export async function activateInstalledPlugins(
  bundle: GenPluginBundler,
  opts: UserDirEnv = {},
): Promise<{ loaded: GenPluginManifest[]; refused: string[] }> {
  const root = userPluginsDir(opts);
  const loaded: GenPluginManifest[] = [];
  const refused: string[] = [];

  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return { loaded, refused };
  }

  for (const name of names) {
    const result = await activateGenPlugin(join(root, name), bundle);
    if (result.ok) loaded.push(result.manifest);
    else refused.push(result.reason);
  }

  return { loaded, refused };
}
