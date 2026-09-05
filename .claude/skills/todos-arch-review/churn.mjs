#!/usr/bin/env node
// Change-history evidence for the todos-arch-review skill: which files and directories a
// range of commits actually touched, and which files keep changing together.

import { execFileSync } from 'node:child_process';

const IGNORED = [
  /^vendor\//,
  /^dist\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /^pnpm-lock\.yaml$/,
  /\.lock$/,
  /^vngen\/state\//,
];

// Field and record separators for `git log --format`. Built by code point rather than written
// literally, because git records a source file carrying a raw NUL as a binary file.
const FS = String.fromCharCode(0);
const RS = String.fromCharCode(1);

function usage() {
  console.error(
    [
      'usage: node churn.mjs [--since <rev|date>] [--range <gitrange>] [--top <n>]',
      '                      [--path <prefix>]... [--all-files]',
      '',
      '  --since   commits after this revision or date (default: 3 months ago)',
      '  --range   explicit git range, e.g. master~40..master (overrides --since)',
      '  --top     how many entries per section (default: 30)',
      '  --path    limit to a path prefix; repeatable',
      '  --all-files  do not drop vendor/dist/lockfile noise',
    ].join('\n'),
  );
  process.exit(2);
}

const opts = { since: '3 months ago', range: null, top: 30, paths: [], allFiles: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--since') opts.since = process.argv[++i];
  else if (a === '--range') opts.range = process.argv[++i];
  else if (a === '--top') opts.top = Number(process.argv[++i]);
  else if (a === '--path') opts.paths.push(process.argv[++i]);
  else if (a === '--all-files') opts.allFiles = true;
  else if (a === '--help' || a === '-h') usage();
  else usage();
}
if (!Number.isFinite(opts.top) || opts.top <= 0) usage();

const args = [
  'log',
  '--no-merges',
  '--numstat',
  '--format=%x01%H%x00%an%x00%ad%x00%s',
  '--date=short',
];
if (opts.range) args.push(opts.range);
else args.push(`--since=${opts.since}`);
if (opts.paths.length) args.push('--', ...opts.paths);

let raw;
try {
  raw = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
} catch (err) {
  console.error(`git log failed: ${err.message}`);
  process.exit(1);
}

const keep = (p) => opts.allFiles || !IGNORED.some((re) => re.test(p));

const commits = [];
for (const chunk of raw.split(RS).slice(1)) {
  const nl = chunk.indexOf('\n');
  const header = nl === -1 ? chunk : chunk.slice(0, nl);
  const [sha, author, date, subject] = header.split(FS);
  const files = [];
  for (const line of (nl === -1 ? '' : chunk.slice(nl + 1)).split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, path] = line.split('\t');
    if (path === undefined) continue;
    // A rename prints as "old => new" (or with a braced common prefix); credit the new path.
    const renamed = path.includes(' => ')
      ? path.replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '')
      : path;
    if (!keep(renamed)) continue;
    files.push({
      path   : renamed,
      added  : added === '-' ? 0 : Number(added),
      deleted: deleted === '-' ? 0 : Number(deleted),
    });
  }
  commits.push({ sha: sha.slice(0, 8), author, date, subject, files });
}

const byFile = new Map();
const byDir = new Map();
const pairs = new Map();

for (const c of commits) {
  const paths = [...new Set(c.files.map((f) => f.path))].sort();
  for (const f of c.files) {
    const e = byFile.get(f.path) ?? { path: f.path, commits: 0, added: 0, deleted: 0 };
    e.commits++;
    e.added += f.added;
    e.deleted += f.deleted;
    byFile.set(f.path, e);

    const dir = f.path.split('/').slice(0, 3).join('/');
    const d = byDir.get(dir) ?? { dir, commits: 0, files: new Set(), added: 0, deleted: 0 };
    d.commits++;
    d.files.add(f.path);
    d.added += f.added;
    d.deleted += f.deleted;
    byDir.set(dir, d);
  }
  // Sprawling commits say nothing about coupling, so they do not vote on co-change.
  if (paths.length > 1 && paths.length <= 12) {
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = `${paths[i]}${FS}${paths[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
}

const desc = (k) => (a, b) => b[k] - a[k] || a.path?.localeCompare?.(b.path) || 0;

const coChange = [...pairs.entries()]
  .map(([key, count]) => {
    const [a, b] = key.split(FS);
    const ratio = count / Math.min(byFile.get(a).commits, byFile.get(b).commits);
    return { a, b, count, ratio: Number(ratio.toFixed(2)) };
  })
  .filter((p) => p.count >= 3)
  .sort((x, y) => y.count - x.count || y.ratio - x.ratio)
  .slice(0, opts.top);

console.log(
  JSON.stringify(
    {
      range       : opts.range ?? `since ${opts.since}`,
      paths       : opts.paths,
      commits     : commits.length,
      filesTouched: byFile.size,
      hotFiles    : [...byFile.values()].sort(desc('commits')).slice(0, opts.top),
      hotDirs: [...byDir.values()]
        .map((d) => ({
          dir    : d.dir,
          commits: d.commits,
          files  : d.files.size,
          added  : d.added,
          deleted: d.deleted,
        }))
        .sort((a, b) => b.commits - a.commits)
        .slice(0, opts.top),
      coChange,
      subjects: commits.map((c) => ({
        sha    : c.sha,
        date   : c.date,
        subject: c.subject,
        files  : c.files.length,
      })),
    },
    null,
    2,
  ),
);
