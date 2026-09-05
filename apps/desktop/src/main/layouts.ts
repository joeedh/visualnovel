import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, exists, sha256 } from '@vn/util';
import { fileCache } from './filecache.js';
import {
  LAYOUT_ATTRIBUTE,
  LAYOUT_ATTRIBUTES_BLOCK,
  LAYOUT_DIR,
  SHIPPED_LAYOUTS,
  type LayoutFile,
  type LayoutSummary,
  parseLayoutFile,
  serializeLayoutFile,
  shippedLayoutFile,
  shippedLayoutFiles,
} from '../shared/layouts.js';

/**
 * Reading and writing `.vnstudio/layouts/`. The format itself lives in `shared/layouts.ts`
 * because the renderer needs it too. This half is the I/O, so the commands over it stay as thin
 * as the rest of `commands/`.
 */

function fileFor(root: string, slug: string): string {
  return join(root, LAYOUT_DIR, `${slug}.json`);
}

/** The same bytes give the same fingerprint on any machine. */
function fingerprint(text: string): string {
  return sha256(text).slice(0, 16);
}

async function slugsOnDisk(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, LAYOUT_DIR)))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every template the project has, shipped ones first and in their own order. A shipped layout
 * with no file still appears, answered for by its built-in definition, so the feature works in a
 * project that predates it.
 */
export async function listLayouts(root: string): Promise<LayoutSummary[]> {
  const found = new Map<string, LayoutSummary>();

  for (const slug of await slugsOnDisk(root)) {
    const text = await fileCache.readText(fileFor(root, slug));
    const parsed = parseLayoutFile(text);
    const shipped = shippedLayoutFile(slug);

    found.set(slug, {
      slug,
      title      : parsed.ok ? parsed.file.title : (shipped?.title ?? slug),
      description: parsed.ok ? parsed.file.description : (shipped?.description ?? ''),
      source     : parsed.ok ? parsed.file.source : shipped ? 'shipped' : 'saved',
      fingerprint: fingerprint(text),
      ...(parsed.ok ? {} : { problem: parsed.problem }),
    });
  }

  const out: LayoutSummary[] = [];
  for (const shipped of SHIPPED_LAYOUTS) {
    out.push(
      found.get(shipped.slug) ?? {
        slug       : shipped.slug,
        title      : shipped.title,
        description: shipped.description,
        source     : 'shipped',
        fingerprint: fingerprint(serializeLayoutFile(shippedLayoutFile(shipped.slug)!)),
      },
    );
    found.delete(shipped.slug);
  }
  for (const summary of found.values()) out.push(summary);
  return out;
}

export type LayoutRead =
  { ok: true; file: LayoutFile; fingerprint: string } | { ok: false; reason: string };

/** One template, or a sentence saying why it cannot be had. A shipped one needs no file. */
export async function readLayout(root: string, slug: string): Promise<LayoutRead> {
  const path = fileFor(root, slug);
  if (!(await exists(path))) {
    const shipped = shippedLayoutFile(slug);
    if (!shipped) return { ok: false, reason: `there is no ${slug} layout in this project` };
    return { ok: true, file: shipped, fingerprint: fingerprint(serializeLayoutFile(shipped)) };
  }

  const relative = `${LAYOUT_DIR}/${slug}.json`;
  const text = await fileCache.readText(path);
  const parsed = parseLayoutFile(text);
  if (!parsed.ok) return { ok: false, reason: `${relative} cannot be read: ${parsed.problem}` };
  return { ok: true, file: parsed.file, fingerprint: fingerprint(text) };
}

/** Write one template. Returns the workspace-relative path, which is what `written` reports. */
export async function writeLayout(root: string, file: LayoutFile): Promise<string> {
  await ensureDir(join(root, LAYOUT_DIR));
  await fileCache.write(fileFor(root, file.slug), serializeLayoutFile(file));
  return `${LAYOUT_DIR}/${file.slug}.json`;
}

/**
 * Put the shipped layouts back. The `all` scope additionally deletes the author's own layouts,
 * which "reset" alone does not promise, so the scope is a named value rather than a boolean flag.
 */
export async function resetLayouts(root: string, scope: 'shipped' | 'all'): Promise<string[]> {
  const written: string[] = [];

  if (scope === 'all') {
    for (const slug of await slugsOnDisk(root)) {
      if (SHIPPED_LAYOUTS.some((entry) => entry.slug === slug)) continue;
      await rm(fileFor(root, slug), { force: true });
      written.push(`${LAYOUT_DIR}/${slug}.json`);
    }
  }

  for (const shipped of SHIPPED_LAYOUTS) {
    written.push(await writeLayout(root, shippedLayoutFile(shipped.slug)!));
  }
  return written;
}

/**
 * Scaffold the layouts a project should have: the directory, any shipped file that is missing,
 * and the merge policy. Never overwrites — an author who edited `writing.json` keeps their edit,
 * and putting it back is `view.resetLayout`'s job, not something opening the project does.
 *
 * Writing outside a command is deliberate and precedented: `openWorkspace` already writes
 * `project.yaml` into a directory that has none. This is bootstrapping the shape of a project,
 * not editing a document.
 */
export async function ensureLayouts(root: string): Promise<string[]> {
  const written: string[] = [];
  await ensureDir(join(root, LAYOUT_DIR));

  for (const file of shippedLayoutFiles()) {
    const path = join(root, file.path);
    if (await exists(path)) continue;
    await fileCache.write(path, file.text);
    written.push(file.path);
  }

  if (await ensureLayoutAttributes(root)) written.push('.gitattributes');
  return written;
}

/**
 * Make sure the project tells git not to merge layouts. Appends rather than replaces, because a
 * `.gitattributes` an author wrote is theirs. Only the one rule needed is added, not this repo's
 * own `* text=auto eol=lf` (for the reason `ensureGitAttributes` gives).
 */
export async function ensureLayoutAttributes(root: string): Promise<boolean> {
  const path = join(root, '.gitattributes');
  const before = (await exists(path)) ? await fileCache.readText(path) : '';
  if (before.includes(LAYOUT_ATTRIBUTE)) return false;

  const head = before === '' || before.endsWith('\n') ? before : `${before}\n`;
  await fileCache.write(path, `${head === '' ? '' : `${head}\n`}${LAYOUT_ATTRIBUTES_BLOCK}`);
  return true;
}
