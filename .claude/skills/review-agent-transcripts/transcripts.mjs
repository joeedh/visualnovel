#!/usr/bin/env node
/**
 * Transcript scanner for the review-agent-transcripts skill.
 *
 * `list` finds vnauthor conversation threads (`vngen/state/threads/*.jsonl`) anywhere under a
 * project repo, keeps the ones inside a window measured back from the *most recent* thread, and
 * marks each with whether a prior review session already covered it.
 *
 * `record` appends this session's ids to the ledger.
 *
 * The ledger lives beside the skill in the codebase repo — `.claude/transcript-review-ledger.json`,
 * gitignored — resolved from this file rather than from the cwd, so it is the same ledger no
 * matter which project repo is being reviewed or where the command was run.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One spelling for a path, so a ledger key written on Windows matches one written anywhere. */
const posix = (p) => p.split(sep).join('/');

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER = resolve(HERE, '..', '..', 'transcript-review-ledger.json');

function usage(msg) {
  console.error(msg);
  console.error(
    'usage: transcripts.mjs list <repo> [--hours N] [--ledger PATH]\n' +
      '       transcripts.mjs record <repo> --ids a,b,c [--note TEXT] [--ledger PATH]',
  );
  process.exit(2);
}

const [cmd, repoArg, ...rest] = process.argv.slice(2);
if (!cmd || !repoArg) usage('missing command or repo path');
const repo = resolve(repoArg);
if (!existsSync(repo)) usage(`no such directory: ${repo}`);

const flags = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i].startsWith('--')) usage(`unexpected argument: ${rest[i]}`);
  flags[rest[i].slice(2)] = rest[i + 1];
}
const ledgerPath = flags.ledger ? resolve(flags.ledger) : DEFAULT_LEDGER;

function loadLedger() {
  if (!existsSync(ledgerPath)) return { v: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    return parsed && parsed.projects ? parsed : { v: 1, projects: {} };
  } catch {
    // A corrupt ledger must not stop a review; it is a memo, not a source of truth.
    return { v: 1, projects: {} };
  }
}

/** Every `vngen/state/threads` directory under the repo. A repo may hold more than one project. */
function threadDirs(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const dir = join(root, e.name);
    if (e.name === 'threads' && posix(root).endsWith('vngen/state')) out.push(dir);
    else threadDirs(dir, depth + 1, out);
  }
  return out;
}

function summarize(file) {
  const text = readFileSync(file, 'utf8');
  const lines = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // A half-written last line is what a crash mid-append leaves behind.
    }
  }
  const header = lines.find((l) => l.type === 'thread');
  if (!header) return null;
  const items = lines.filter((l) => l.type === 'item');
  const title = [...lines].reverse().find((l) => l.type === 'title')?.title ?? header.title;
  const counts = {};
  const tools = {};
  for (const it of items) {
    counts[it.role] = (counts[it.role] ?? 0) + 1;
    if (it.role === 'tool') tools[it.text] = (tools[it.text] ?? 0) + 1;
    if (it.detail && it.detail.ok === false) counts.toolFailures = (counts.toolFailures ?? 0) + 1;
  }
  return {
    id: header.id,
    file,
    title,
    startedAt: header.startedAt,
    endedAt: items.length ? (items[items.length - 1].at ?? null) : null,
    model: header.model ?? null,
    effort: header.effort ?? null,
    commit: header.commit ?? null,
    bytes: statSync(file).size,
    items: items.length,
    counts,
    toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
    // The whole census of a 300-call thread is longer than the reading it exists to guide, so
    // the list is what the thread mostly did. `show` has the rest.
    topTools: Object.fromEntries(
      Object.entries(tools)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    ),
    lines: items,
  };
}

const all = [];
for (const dir of threadDirs(repo)) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const s = summarize(join(dir, name));
    if (s) all.push(s);
  }
}
all.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

const ledger = loadLedger();
const key = posix(repo);
const seen = new Map((ledger.projects[key]?.reviewed ?? []).map((r) => [r.id, r]));

if (cmd === 'list') {
  if (all.length === 0) {
    console.log(JSON.stringify({ repo: key, transcripts: [], ledgerPath }, null, 2));
    process.exit(0);
  }
  const hours = flags.hours === undefined ? 24 : Number(flags.hours);
  if (!Number.isFinite(hours) || hours < 0) usage(`--hours must be a non-negative number`);
  const newest = all[all.length - 1];
  const cutoff = new Date(new Date(newest.startedAt).getTime() - hours * 3600_000).toISOString();
  const inWindow = all.filter((t) => t.startedAt >= cutoff);
  console.log(
    JSON.stringify(
      {
        repo: key,
        ledgerPath,
        hours,
        newest: { id: newest.id, startedAt: newest.startedAt, title: newest.title },
        cutoff,
        totalTranscripts: all.length,
        transcripts: inWindow.map((t) => ({
          ...t,
          lines: undefined,
          file: posix(relative(repo, t.file)),
          absFile: t.file,
          reviewed: seen.has(t.id),
          reviewedAt: seen.get(t.id)?.reviewedAt ?? null,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (cmd === 'show') {
  if (!flags.ids) usage('show needs --ids');
  const wanted = new Set(
    flags.ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const picked = all.filter((t) => wanted.has(t.id));
  for (const id of wanted)
    if (!picked.some((t) => t.id === id)) console.error(`no transcript ${id}`);
  for (const t of picked) {
    console.log(`
===== ${t.id} — ${t.title}`);
    console.log(
      `start ${t.startedAt}  end ${t.endedAt}  model ${t.model} (${t.effort})  commit ${t.commit}`,
    );
    for (const it of t.lines) {
      const head = `[${it.id}] ${it.role}${it.at ? ` @${it.at.slice(11, 19)}` : ''}`;
      console.log(`${head}: ${it.full ?? it.text}`);
      if (it.detail?.args) console.log(`      args: ${it.detail.args}`);
      if (it.detail && it.detail.ok === false) console.log('      FAILED');
      if (it.detail?.output) console.log(`      out: ${it.detail.output}`);
    }
  }
  process.exit(0);
}

if (cmd === 'record') {
  if (!flags.ids) usage('record needs --ids');
  const at = new Date().toISOString();
  const ids = flags.ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids)
    seen.set(id, { id, reviewedAt: at, ...(flags.note ? { note: flags.note } : {}) });
  ledger.projects[key] = {
    lastReviewedAt: at,
    reviewed: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  console.log(`recorded ${ids.length} transcript(s) in ${ledgerPath}`);
  process.exit(0);
}

usage(`unknown command: ${cmd}`);
