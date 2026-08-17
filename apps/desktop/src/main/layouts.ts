import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Git } from '@vn/git';
import { ensureDir, exists, sha256, writeFileAtomic } from '@vn/util';
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
 * because the renderer needs it too; this half is the I/O, so the commands stay the thin
 * wrappers over it that the rest of `commands/` is.
 */

function fileFor(root: string, slug: string): string {
  return join(root, LAYOUT_DIR, `${slug}.json`);
}

/** Cheap and stable: same bytes, same fingerprint, on any machine. */
function fingerprint(text: string): string {
  return sha256(text).slice(0, 16);
}

/**
 * The porcelain codes that mean a merge left this path unresolved. Pure so the merge policy is
 * testable without a repo — `git status` gives these two characters and nothing else says it.
 */
export function isConflictCode(x: string, y: string): boolean {
  const code = `${x}${y}`;
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
}

/** Which layout paths git is currently reporting as conflicted, workspace-relative. */
async function conflictedPaths(git: Git | undefined): Promise<Set<string>> {
  if (!git) return new Set();
  try {
    const status = await git.status();
    return new Set(
      status.entries
        .filter(
          (entry) => isConflictCode(entry.x, entry.y) && entry.path.startsWith(`${LAYOUT_DIR}/`),
        )
        .map((entry) => entry.path),
    );
  } catch {
    return new Set();
  }
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
 * with no file still appears — the recipe answers for it — so the feature works on day one in
 * a project that predates it.
 */
export async function listLayouts(root: string, git?: Git): Promise<LayoutSummary[]> {
  const conflicted = await conflictedPaths(git);
  const found = new Map<string, LayoutSummary>();

  for (const slug of await slugsOnDisk(root)) {
    const relative = `${LAYOUT_DIR}/${slug}.json`;
    const text = await readFile(fileFor(root, slug), 'utf8');
    const parsed = parseLayoutFile(text);
    const shipped = shippedLayoutFile(slug);

    const problem = conflicted.has(relative)
      ? 'a merge left this layout unresolved — pick a side with `git checkout --ours` or `--theirs`, then `git add` it'
      : parsed.ok
        ? undefined
        : parsed.problem;

    found.set(slug, {
      slug,
      title: parsed.ok ? parsed.file.title : (shipped?.title ?? slug),
      description: parsed.ok ? parsed.file.description : (shipped?.description ?? ''),
      source: parsed.ok ? parsed.file.source : shipped ? 'shipped' : 'saved',
      fingerprint: fingerprint(text),
      ...(problem ? { problem } : {}),
    });
  }

  const out: LayoutSummary[] = [];
  for (const shipped of SHIPPED_LAYOUTS) {
    out.push(
      found.get(shipped.slug) ?? {
        slug: shipped.slug,
        title: shipped.title,
        description: shipped.description,
        source: 'shipped',
        fingerprint: fingerprint(serializeLayoutFile(shippedLayoutFile(shipped.slug)!)),
      },
    );
    found.delete(shipped.slug);
  }
  for (const summary of found.values()) out.push(summary);
  return out;
}

export type LayoutRead =
  | { ok: true; file: LayoutFile; fingerprint: string }
  | { ok: false; reason: string };

/** One template, or a sentence saying why it cannot be had. A shipped one needs no file. */
export async function readLayout(root: string, slug: string, git?: Git): Promise<LayoutRead> {
  const path = fileFor(root, slug);
  if (!(await exists(path))) {
    const shipped = shippedLayoutFile(slug);
    if (!shipped) return { ok: false, reason: `there is no ${slug} layout in this project` };
    return { ok: true, file: shipped, fingerprint: fingerprint(serializeLayoutFile(shipped)) };
  }

  const relative = `${LAYOUT_DIR}/${slug}.json`;
  if ((await conflictedPaths(git)).has(relative)) {
    return {
      ok: false,
      reason:
        `${relative} is mid-merge, so there is no one arrangement to apply. Pick a side with ` +
        `\`git checkout --ours ${relative}\` or \`--theirs\`, then \`git add\` it.`,
    };
  }

  const text = await readFile(path, 'utf8');
  const parsed = parseLayoutFile(text);
  if (!parsed.ok) return { ok: false, reason: `${relative} cannot be read: ${parsed.problem}` };
  return { ok: true, file: parsed.file, fingerprint: fingerprint(text) };
}

/** Write one template. Returns the workspace-relative path, which is what `written` reports. */
export async function writeLayout(root: string, file: LayoutFile): Promise<string> {
  await ensureDir(join(root, LAYOUT_DIR));
  await writeFileAtomic(fileFor(root, file.slug), serializeLayoutFile(file));
  return `${LAYOUT_DIR}/${file.slug}.json`;
}

/**
 * Put the shipped layouts back. `all` additionally deletes the author's own, which "reset" does
 * not promise on its own — hence two words rather than one flag.
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
    await writeFileAtomic(path, file.text);
    written.push(file.path);
  }

  if (await ensureLayoutAttributes(root)) written.push('.gitattributes');
  return written;
}

/**
 * Make sure the project tells git not to merge layouts. Appends: a `.gitattributes` an author
 * wrote is theirs, and this adds only the one rule it needs — not this repo's own
 * `* text=auto eol=lf`, for the reason `ensureGitAttributes` gives.
 */
export async function ensureLayoutAttributes(root: string): Promise<boolean> {
  const path = join(root, '.gitattributes');
  const before = (await exists(path)) ? await readFile(path, 'utf8') : '';
  if (before.includes(LAYOUT_ATTRIBUTE)) return false;

  const head = before === '' || before.endsWith('\n') ? before : `${before}\n`;
  await writeFile(path, `${head === '' ? '' : `${head}\n`}${LAYOUT_ATTRIBUTES_BLOCK}`);
  return true;
}
