/**
 * What "the source" means to the debug agent.
 *
 * A declared manifest rather than whatever is on disk, for two reasons. It keeps `node_modules`,
 * build output and several megabytes of minified vendor blobs out of the walk, which is most of
 * the token saving the checkbox promises. And should the app ever ship less than all of itself,
 * narrowing is an edit to one list: the tools keep working and the refusals stay honest — "the UI
 * layer is not included in this build" rather than a confusing "no such file".
 *
 * `docs/` and `CLAUDE.md` are the highest-value entries here, arguably above the TypeScript. They
 * state the invariants in prose, so a report can say which contract was broken instead of
 * paraphrasing code it half-read.
 */
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Top-level paths the analyst may read. Every path outside them is refused. */
export const READABLE = [
  'packages',
  'apps',
  'docs',
  'scripts',
  'CLAUDE.md',
  'package.json',
] as const;

/**
 * Paths never walked or read, even under a readable root. `keys` is here as well as in the
 * project-side refusal, because an analyst that has just read a private manuscript must not be one
 * step from a credential. The `apps/desktop` entries are build and dev output that exists only in a
 * checkout; `scripts/package.desktop.mjs` copies this manifest into the installer, so one left out
 * would package the previous run's output into the next run's.
 */
export const DENY = [
  'node_modules',
  'dist',
  '.git',
  '.turbo',
  'keys',
  'vendor/path.ux/scripts/lib',
  'apps/desktop/.package',
  'apps/desktop/release',
  'apps/desktop/.vndesktop',
] as const;

/** File kinds worth reading. Anything else is a binary or a build artefact. */
export const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.css',
  '.html',
  '.txt',
  '.fountain',
] as const;

/** Workspace-relative and forward-slashed, which is the only form the predicates here accept. */
export function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** True when `rel` is, or is under, one of `entries`. Segment-wise, so `distant` is not `dist`. */
function under(rel: string, entries: readonly string[]): boolean {
  const norm = normalize(rel);
  return entries.some((entry) => norm === entry || norm.startsWith(`${entry}/`));
}

/**
 * True when `rel` is denied. A one-segment entry is denied wherever it appears, because
 * `node_modules` nests; a multi-segment entry names one place and is matched as a prefix, or
 * `vendor/path.ux/scripts/lib` would deny every `scripts/` in the repo.
 */
export function denied(rel: string): boolean {
  const norm = normalize(rel);
  const names = DENY.filter((entry) => !entry.includes('/'));
  const places = DENY.filter((entry) => entry.includes('/'));
  if (under(norm, places)) return true;
  return norm.split('/').some((segment) => (names as readonly string[]).includes(segment));
}

/** True when the analyst may read this path out of the source root. */
export function readableSourcePath(rel: string): boolean {
  const norm = normalize(rel);
  if (norm === '' || norm.startsWith('..')) return false;
  return under(norm, READABLE) && !denied(norm);
}

/** True when the file's extension is one worth handing a model. */
export function textFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (TEXT_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext));
}

/** Two files that together mean "this is the source tree and not some directory above it". */
const MARKERS = ['CLAUDE.md', 'packages'];

async function looksLikeSource(dir: string): Promise<boolean> {
  for (const marker of MARKERS) {
    try {
      await fs.stat(join(dir, marker));
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Where the shipped source lives. Checks `VN_SOURCE_ROOT` first, then the unpacked resource an
 * install ships, then walks upward from `hint` (the caller's own directory) to find a checkout.
 *
 * `undefined` means a broken install, and the caller says so rather than quietly analysing less.
 */
export async function sourceRoot(hint?: string): Promise<string | undefined> {
  const fromEnv = process.env.VN_SOURCE_ROOT?.trim();
  if (fromEnv && (await looksLikeSource(resolve(fromEnv)))) return resolve(fromEnv);

  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const packaged = join(resources, 'source');
    if (await looksLikeSource(packaged)) return packaged;
  }

  let cur = resolve(hint ?? here());
  for (;;) {
    if (await looksLikeSource(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * This module's own directory. `__dirname` rather than `import.meta.url` for the same reason
 * `@vn/testkit` uses it: main bundles to CommonJS and jest's esbuild transform does too, so
 * `import.meta` is the form that is absent at runtime. Guarded, so an ESM build degrades to the
 * working directory instead of throwing.
 */
function here(): string {
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}
