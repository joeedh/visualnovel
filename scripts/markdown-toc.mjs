/**
 * Generate/update tables of contents in `docs/*.md` and `docs/research/*.md`.
 *
 * Plan files (`docs/plans/**`, the archive included) are intentionally excluded — they're
 * living documents whose headings churn as work proceeds, and a TOC there is more noise
 * than signal.
 *
 * markdown-toc only touches a file that already has `<!-- toc -->` / `<!-- tocstop -->`
 * markers, so this first inserts them (right after the leading H1) into any target file
 * that lacks them, then runs markdown-toc's insert on every target file.
 *
 * Usage: `pnpm markdown-toc`
 */
import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import markdownToc from 'markdown-toc';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGET_DIRS = ['docs', 'docs/research'];

const TOC_MARKER_RE = /<!--[ \t]*toc[ \t]*-->/;
const H1_RE = /^(#[^\n]*\n)/;

async function targetFiles() {
  const files = [];
  for (const dir of TARGET_DIRS) {
    const entries = await fs.readdir(resolve(ROOT, dir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(resolve(ROOT, dir, entry.name));
      }
    }
  }
  return files;
}

function ensureMarkers(content) {
  const markers = '\n<!-- toc -->\n\n<!-- tocstop -->\n';
  if (H1_RE.test(content)) {
    return content.replace(H1_RE, `$1${markers}`);
  }
  return `${markers}\n${content}`;
}

async function updateFile(file) {
  const before = await fs.readFile(file, 'utf8');
  // Files without headings (besides a possible leading H1) have nothing to link to —
  // skip them rather than inject an empty <!-- toc --> block.
  if (markdownToc(before).json.length === 0) return false;

  const withMarkers = TOC_MARKER_RE.test(before) ? before : ensureMarkers(before);
  const after = markdownToc.insert(withMarkers);
  if (after !== before) {
    await fs.writeFile(file, after);
    return true;
  }
  return false;
}

const files = await targetFiles();
let changed = 0;
for (const file of files) {
  if (await updateFile(file)) changed += 1;
}
process.stderr.write(`markdown-toc: ${changed}/${files.length} file(s) updated\n`);
