#!/usr/bin/env node
// Inventories docs/plans/archive/*.md: git-add date (oldest first) and any
// inbound links from outside docs/plans/archive/. Run with no args.
//
// Usage: node .claude/skills/archive-plans/inventory.mjs [--keep N]

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const archiveDir = path.join(repoRoot, 'docs', 'plans', 'archive');

const keepArgIndex = process.argv.indexOf('--keep');
const keepCount = keepArgIndex !== -1 ? Number(process.argv[keepArgIndex + 1]) : 10;

const mdFiles = readdirSync(archiveDir).filter((f) => f.endsWith('.md'));

function firstAddDate(relPath) {
  const out = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', relPath],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  const lines = out.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '1970-01-01T00:00:00Z';
}

const entries = mdFiles.map((f) => {
  const rel = path.join('docs', 'plans', 'archive', f).split(path.sep).join('/');
  return { file: f, rel, addedAt: firstAddDate(rel) };
});

entries.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1)); // newest first

// Find inbound links, from two greps merged together:
//  1. any path ending in "archive/<file>" — a doc under docs/ links with a
//     relative path like "../plans/archive/x.md", code outside docs/ with the
//     full "docs/plans/archive/x.md", both caught by the "archive/x.md" suffix.
//  2. the bare filename, but ONLY within docs/plans/archive/ itself — a sibling
//     plan there links to another with no "archive/" prefix at all (same dir).
// A sibling plan that stays unzipped and links to this one is a real backlink:
// only self-references are excluded, since zipping one and not the other
// breaks that link.
function grepFiles(pattern) {
  let out;
  try {
    out = execFileSync('git', ['grep', '-l', '--fixed-strings', pattern], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return []; // git grep exits 1 when there are no matches
  }
  return out.split('\n').filter(Boolean);
}

function findBacklinks(fileName) {
  const self = `docs/plans/archive/${fileName}`;
  const hits = new Set([
    ...grepFiles(`archive/${fileName}`),
    ...grepFiles(fileName).filter((p) => p.startsWith('docs/plans/archive/')),
  ]);
  hits.delete(self);
  return [...hits].filter((p) => !p.includes('/.package/') && !p.includes('release/')).sort();
}

for (const e of entries) {
  e.backlinks = findBacklinks(e.file);
}

const keep = entries.slice(0, keepCount);
const candidates = entries.slice(keepCount);
const referencedCandidates = candidates.filter((e) => e.backlinks.length);
const plainCandidates = candidates.filter((e) => !e.backlinks.length);

console.log(
  JSON.stringify(
    {
      totalArchived: entries.length,
      keepCount,
      keep: keep.map((e) => e.file),
      candidatesToZip: plainCandidates.map((e) => e.file),
      candidatesNeedingExtraction: referencedCandidates.map((e) => ({
        file: e.file,
        backlinks: e.backlinks,
      })),
    },
    null,
    2,
  ),
);
