#!/usr/bin/env node
/**
 * Ledger for the comment-audit skill.
 *
 * `list` reports every candidate file with its audit state; `pick <n>` chooses the n most
 * comment-heavy files that were never audited (then the stale ones); `record <file...>` marks
 * files as audited at their current content.
 *
 * The ledger is `.claude/comment-audit-ledger.json`, resolved from this file so the cwd does
 * not matter. It is COMMITTED: an entry stores the file's git blob hash at audit time, so
 * "stale" means the content changed since the audit, independent of commits and branches.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const LEDGER = resolve(ROOT, '.claude', 'comment-audit-ledger.json');

/** Files worth auditing: tracked source code, not vendored, generated or authored elsewhere. */
const INCLUDE = /\.(ts|tsx|js|mjs|css)$/;
const EXCLUDE = /^(vendor\/|examples\/|docs\/|templates\/)|(^|\/)dist\//;

function usage() {
  console.error(
    'usage: ledger.mjs list [--all]\n' +
      '       ledger.mjs pick <n>\n' +
      '       ledger.mjs record <file...>',
  );
  process.exit(2);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function loadLedger() {
  if (!existsSync(LEDGER)) return { v: 1, files: {} };
  const parsed = JSON.parse(readFileSync(LEDGER, 'utf8'));
  return parsed && typeof parsed === 'object' && parsed.files ? parsed : { v: 1, files: {} };
}

function saveLedger(ledger) {
  const files = Object.fromEntries(
    Object.entries(ledger.files).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  writeFileSync(LEDGER, `${JSON.stringify({ v: 1, files }, null, 2)}\n`, 'utf8');
}

function candidates() {
  return git(['ls-files'])
    .split('\n')
    .filter((p) => p && INCLUDE.test(p) && !EXCLUDE.test(p));
}

/** Rough count of comment lines — enough to rank files by how much there is to audit. */
function commentLines(path) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, path), 'utf8');
  } catch {
    return 0;
  }
  return text.split('\n').filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l) || /\S.*\/\/ /.test(l)).length;
}

/** Current blob hash per path, batched so the command line stays short on Windows. */
function blobHashes(paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += 50) {
    const chunk = paths.slice(i, i + 50);
    const hashes = git(['hash-object', '--', ...chunk])
      .trim()
      .split('\n');
    chunk.forEach((p, j) => out.set(p, hashes[j]));
  }
  return out;
}

function statusOf(paths, ledger) {
  const hashes = blobHashes(paths);
  return paths.map((path) => {
    const entry = ledger.files[path];
    const state = !entry ? 'never' : entry.blob === hashes.get(path) ? 'clean' : 'stale';
    return {
      path,
      state,
      commentLines: commentLines(path),
      ...(entry ? { auditedAt: entry.auditedAt } : {}),
    };
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const ledger = loadLedger();

if (cmd === 'list') {
  const all = rest.includes('--all');
  const rows = statusOf(candidates(), ledger).filter((r) => all || r.state !== 'clean');
  rows.sort((a, b) => b.commentLines - a.commentLines);
  console.log(JSON.stringify({ ledger: LEDGER, files: rows }, null, 2));
} else if (cmd === 'pick') {
  const n = Number(rest[0]);
  if (!Number.isInteger(n) || n < 1) usage();
  const rows = statusOf(candidates(), ledger).filter((r) => r.state !== 'clean');
  // Never-audited files first, then stale ones; within each group, the most comments first.
  rows.sort((a, b) =>
    a.state === b.state ? b.commentLines - a.commentLines : a.state === 'never' ? -1 : 1,
  );
  console.log(JSON.stringify({ ledger: LEDGER, files: rows.slice(0, n) }, null, 2));
} else if (cmd === 'record') {
  if (rest.length === 0) usage();
  const paths = rest
    .map((p) => resolve(ROOT, p))
    .map((p) => git(['ls-files', '--full-name', '--', p]).trim());
  const missing = paths.filter((p) => !p);
  if (missing.length || paths.length !== rest.length) {
    console.error('record: every file must be tracked by git');
    process.exit(1);
  }
  const hashes = blobHashes(paths);
  const auditedAt = new Date().toISOString();
  for (const path of paths) ledger.files[path] = { auditedAt, blob: hashes.get(path) };
  saveLedger(ledger);
  console.log(`recorded ${paths.length} file(s) in ${LEDGER}`);
} else {
  usage();
}
