/**
 * Verify every relative markdown link under `docs/**` (plus the root `*.md` files) points at
 * a file that exists — and, when it carries a `#fragment`, at a heading that exists.
 *
 * External URLs are out of scope on purpose: the one set worth checking against the network is
 * the vendor pages in `docs/guides/api-keys.md`, and `check-key-links.mjs` already owns that. This
 * checker is offline and instant, so it can run on every lint.
 *
 * Anchors are slugified with the same `markdown-toc` package `markdown-toc.mjs` uses, so this
 * checker and the generated TOCs cannot disagree about what a heading's anchor is.
 *
 * Usage: `node scripts/check-doc-links.mjs`  (exits non-zero listing every broken link)
 */
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import markdownToc from 'markdown-toc';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .md under docs/ plus the loose ones at the repo root. */
async function targetFiles() {
  const files = [];
  for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(ROOT, entry.name));
  }
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  }
  await walk(join(ROOT, 'docs'));
  return files;
}

/** Inline `[x](target)` / `![x](target)` plus reference definitions `[x]: target`. */
function linksIn(content) {
  const out = [];
  // Fenced code blocks routinely show example paths that do not exist; drop them first.
  const prose = content.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  for (const m of prose.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) out.push(m[1]);
  for (const m of prose.matchAll(/^\[[^\]]+\]:\s+<?(\S+?)>?\s*$/gm)) out.push(m[1]);
  return out;
}

const anchorCache = new Map();
async function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const toc = markdownToc(await fs.readFile(file, 'utf8'), { firsth1: true });
    anchorCache.set(file, new Set(toc.json.map((h) => h.slug)));
  }
  return anchorCache.get(file);
}

const problems = [];
for (const file of await targetFiles()) {
  const content = await fs.readFile(file, 'utf8');
  const here = relative(ROOT, file);
  for (const raw of linksIn(content)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, https:, mailto:, vscode:, …
    const [path, fragment] = raw.split('#');
    const target = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) {
      problems.push(`${here}: broken link -> ${raw}`);
      continue;
    }
    if (fragment !== undefined && stat.isFile() && target.endsWith('.md')) {
      if (!(await anchorsOf(target)).has(decodeURIComponent(fragment))) {
        problems.push(`${here}: missing anchor -> ${raw}`);
      }
    }
  }
}

if (problems.length) {
  process.stderr.write(problems.join('\n') + `\n\n${problems.length} broken link(s)\n`);
  process.exit(1);
}
process.stderr.write('check-doc-links: all relative links resolve\n');
