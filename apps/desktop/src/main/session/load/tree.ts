import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Workspace-relative and forward-slashed, which is what a `written` list reports. */
export function relPath(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}

/**
 * Directories no file tree of a project should ever show, and the walk's cap. `.vnstudio` holds
 * the layout templates, which are surfaced through the View menu; a serialized JSON mesh is not
 * a document anyone opens in an editor.
 */
export const TREE_SKIP = new Set(['.git', 'node_modules', '.vnstudio']);
export const TREE_MAX_FILES = 5000;

/**
 * Every file under `dir` as workspace-relative `/` paths. Bounded rather than exhaustive: a
 * project holding a copied asset library should slow the sidebar down, not the main process.
 */
export async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (abs: string, prefix: string): Promise<void> => {
    if (out.length >= TREE_MAX_FILES) return;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= TREE_MAX_FILES) return;
      if (TREE_SKIP.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(abs, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await visit(dir, '');
  return out;
}

/**
 * Every directory under `dir` as `dir`-relative `/` paths, parents before their children. It is
 * the one source of the folders no file path implies, which is how a tree shows an empty folder.
 * Skips and stops as {@link walkFiles} does.
 */
export async function walkDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (abs: string, prefix: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= TREE_MAX_FILES) return;
      if (TREE_SKIP.has(entry.name) || !entry.isDirectory()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      await visit(join(abs, entry.name), rel);
    }
  };
  await visit(dir, '');
  return out;
}
