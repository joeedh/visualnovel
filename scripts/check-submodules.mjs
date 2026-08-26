/**
 * Fail loudly when a git submodule is declared but not checked out.
 *
 * The renderer compiles path.ux from source through a vite alias, so an uninitialized
 * `vendor/path.ux` surfaces as an unresolvable-import error a long way from its cause.
 * This names the fix instead. Nested submodules (path.ux carries path-controller) are
 * found by reading each submodule's own `.gitmodules`, so nothing here hard-codes a layout.
 *
 * It also catches the quieter half of the same problem: a submodule that is checked out but
 * whose own dependencies were never installed. path.ux is a project of its own with its own
 * lockfile and is not a pnpm workspace member, so the root install does not reach it — and the
 * failure that produces is scores of "has no exported member" errors from inside `vendor/`,
 * which name a symbol rather than the install that is missing.
 *
 * Usage: `pnpm check:setup` (and as the desktop build's first step).
 */
import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PATH_RE = /^\s*path\s*=\s*(.+?)\s*$/gm;

/**
 * Submodules that are consumed as a published package would be, from the build output they
 * commit. Nothing here reads their sources, so their own dependencies are never needed and an
 * absent `node_modules` is not a problem to report.
 */
const PREBUILT = new Set(['vendor/nstructjs']);

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

/** Whether a path exists at all, file or directory. */
async function exists(path) {
  return fs.stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Walks submodules depth-first, collecting two kinds of not-ready: declared but empty, and
 * checked out but never installed. The second kind is subtler: a submodule with its own
 * `package.json` is not a workspace member, so the root `pnpm install` does not reach it, and
 * what it needs goes missing without anything saying so. path.ux is exactly that shape, and the
 * failure it produces is a wall of "has no exported member" errors from inside `vendor/`.
 */
async function survey(base, found = { missing: [], uninstalled: [] }) {
  for (const rel of await declaredPaths(join(base, '.gitmodules'))) {
    const dir = join(base, rel);
    if (!(await isPopulated(dir))) {
      found.missing.push(dir);
      continue;
    }
    if (
      !PREBUILT.has(relative(dir)) &&
      (await exists(join(dir, 'package.json'))) &&
      !(await isPopulated(join(dir, 'node_modules')))
    ) {
      found.uninstalled.push(dir);
    }
    await survey(dir, found);
  }
  return found;
}

/** A repo-root-relative path with forward slashes, which is how the fix is spelled. */
function relative(dir) {
  return dir.slice(ROOT.length + 1).replaceAll('\\', '/');
}

const { missing, uninstalled } = await survey(ROOT);

if (missing.length > 0) {
  process.stderr.write(
    [
      `Submodule${missing.length > 1 ? 's are' : ' is'} not checked out:`,
      ...missing.map((dir) => `  ${relative(dir)}`),
      '',
      'Run this from the repository root, then try again:',
      '',
      '  git submodule update --init --recursive',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

if (uninstalled.length > 0) {
  process.stderr.write(
    [
      `Submodule${uninstalled.length > 1 ? 's carry' : ' carries'} dependencies of its own that ` +
        'are not installed:',
      ...uninstalled.map((dir) => `  ${relative(dir)}`),
      '',
      'A submodule is not a workspace member, so the root install does not reach it. Run this',
      'from the repository root, then try again:',
      '',
      ...uninstalled.map((dir) => `  pnpm --dir ${relative(dir)} install`),
      '',
    ].join('\n'),
  );
  process.exit(1);
}
