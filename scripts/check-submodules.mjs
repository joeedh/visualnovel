/**
 * Fail loudly when a git submodule is declared but not checked out.
 *
 * The renderer compiles path.ux from source through a vite alias, so an uninitialized
 * `vendor/path.ux` surfaces as an unresolvable-import error a long way from its cause.
 * This names the fix instead. Nested submodules (path.ux carries path-controller) are
 * found by reading each submodule's own `.gitmodules`, so nothing here hard-codes a layout.
 *
 * Usage: `pnpm doctor` (and as the desktop build's first step).
 */
import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PATH_RE = /^\s*path\s*=\s*(.+?)\s*$/gm;

/** The `path =` entries of a `.gitmodules` file; empty when there is no such file. */
async function declaredPaths(gitmodules) {
  const content = await fs.readFile(gitmodules, 'utf8').catch(() => null);
  if (content === null) return [];
  return [...content.matchAll(PATH_RE)].map((m) => m[1]);
}

/**
 * A submodule is checked out when its directory has anything in it — `git submodule add`
 * leaves an empty directory behind until `update --init` populates it.
 */
async function isPopulated(dir) {
  const entries = await fs.readdir(dir).catch(() => null);
  return entries !== null && entries.length > 0;
}

/** Walk submodules depth-first, collecting the paths that are declared but empty. */
async function findMissing(base, missing = []) {
  for (const rel of await declaredPaths(join(base, '.gitmodules'))) {
    const dir = join(base, rel);
    if (await isPopulated(dir)) {
      await findMissing(dir, missing);
    } else {
      missing.push(dir);
    }
  }
  return missing;
}

const missing = await findMissing(ROOT);
if (missing.length > 0) {
  const list = missing.map((dir) => `  ${dir.slice(ROOT.length + 1).replaceAll('\\', '/')}`);
  process.stderr.write(
    [
      `Submodule${missing.length > 1 ? 's are' : ' is'} not checked out:`,
      ...list,
      '',
      'Run this from the repository root, then try again:',
      '',
      '  git submodule update --init --recursive',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
