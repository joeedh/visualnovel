/**
 * Tier 2 of [`docs/plans/auditing-the-api-key-instructions.md`]: the weekly, advisory half.
 *
 * For each vendor section of `docs/api-keys.md` it fetches that vendor's own documentation, hands
 * both to a model, and writes `key-instructions-review.md` saying agree / drifted /
 * could-not-check. `.github/workflows/key-docs-audit.yml` runs it on a cron and turns a drifted
 * run into one issue.
 *
 * It always exits 0. Advisory means advisory: a vendor's page being slow, or a model being
 * unavailable, must not be something anyone has to go and clear. The one thing that would make
 * this dangerous is the one thing it does not do — it opens `docs/api-keys.md` for reading and
 * never writes to it, because an unreviewed model edit landing in the file a confused new user
 * follows is the highest-consequence automated write in this repo.
 *
 * Everything that decides anything is in `apps/desktop/src/main/keyaudit.ts`, which has tests.
 * What is here is the network, the key, and the file.
 *
 * Usage:
 *   node scripts/audit-key-instructions.mjs [--out key-instructions-review.md] [--model <id>]
 *   node scripts/audit-key-instructions.mjs --dry-run    # fetch and assemble, ask nothing
 *
 * It needs one model key in the environment, the same variables the app itself reads. `--dry-run`
 * needs none: it does everything except the call, which is how you check that the audit is still
 * reading the pages you think it is without spending anything.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const GUIDE = join(root, 'docs/api-keys.md');
const TMP = resolve(root, 'apps/desktop/.keyaudit-entry.cjs');

/** Long enough for a slow docs site; this runs once a week and nothing waits on it. */
const TIMEOUT_MS = 30_000;

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'accept-language': 'en',
};

/** The date the review says it was run, in the one format that sorts. */
const stamp = () => new Date().toISOString().slice(0, 10);

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const outPath = resolve(root, flag('out', 'key-instructions-review.md'));
if (resolve(outPath) === resolve(GUIDE)) {
  throw new Error('refusing to write to docs/api-keys.md — this audit proposes, a person applies');
}

await build({
  stdin: {
    contents: [
      "export { KEY_VENDORS } from '@vn/config';",
      "export { chatBackendFor, chatVendorFor } from '@vn/providers';",
      "export { blockText } from './apps/desktop/src/shared/markdown.js';",
      "export { parseKeyGuide } from './apps/desktop/src/shared/apikeys.js';",
      'export { AUDIT_SYSTEM, auditPrompt, hasDrift, htmlToText, pageProblem, parseReview,',
      "  renderReview, unreadable } from './apps/desktop/src/main/keyaudit.js';",
      "export { extractJson } from '@vn/providers';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  outfile: TMP,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias,
  external: EXTERNAL,
  logLevel: 'warning',
});

const {
  AUDIT_SYSTEM,
  KEY_VENDORS,
  auditPrompt,
  blockText,
  chatBackendFor,
  chatVendorFor,
  extractJson,
  hasDrift,
  htmlToText,
  pageProblem,
  parseKeyGuide,
  parseReview,
  renderReview,
  unreadable,
} = createRequire(import.meta.url)(TMP);
await fs.rm(TMP, { force: true });

const guide = parseKeyGuide(await fs.readFile(GUIDE, 'utf8'));

/** Fetch one page as readable text, or say why not. Never throws — the caller wants a verdict. */
async function readPage(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: HEADERS,
      signal: abort.signal,
    });
    if (!response.ok) return { problem: `the page answered HTTP ${response.status}` };
    const text = htmlToText(await response.text());
    const problem = pageProblem(text);
    return problem ? { problem } : { text };
  } catch (err) {
    const what = err.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000}s` : err.message;
    return { problem: `the page could not be fetched — ${what}` };
  } finally {
    clearTimeout(timer);
  }
}

// The model, and the one key it needs. The variable is read off the guide itself rather than
// named here, so the audit authenticates through exactly the variable its own documentation tells
// a new user to set — if that line ever goes stale, this stops working and says so.
const dryRun = process.argv.includes('--dry-run');
const model = flag('model', process.env.VN_AUDIT_MODEL ?? 'claude-sonnet-5');
const keys = Object.fromEntries(guide.vendors.map((v) => [v.vendor, process.env[v.env] ?? '']));
const need = chatVendorFor(model);
const envName =
  guide.vendors.find((v) => v.vendor === need)?.env ?? `${need.toUpperCase()}_API_KEY`;

let backend;
if (dryRun) {
  backend = undefined;
} else if (keys[need]) {
  backend = chatBackendFor(model, keys).backend;
} else {
  // Still not an error exit. A missing secret is a repo-configuration problem, and it should
  // surface as a review saying so rather than as a red cron nobody is on the hook for. The
  // variable is named; its value never is.
  console.error(`[audit] $${envName} is not set, so ${model} cannot be asked anything`);
  const blocked = guide.vendors.map((v) =>
    unreadable(v.vendor, `no model key was available to run the audit — $${envName} is not set`),
  );
  await fs.writeFile(outPath, renderReview(blocked, stamp()), 'utf8');
  process.exit(0);
}

const reviews = [];
for (const vendor of guide.vendors) {
  console.log(`[audit] ${vendor.vendor} — reading ${vendor.docs}`);
  const page = await readPage(vendor.docs);
  if (page.problem) {
    reviews.push(unreadable(vendor.vendor, `${vendor.docs}: ${page.problem}`));
    continue;
  }

  // The steps as they are written, which is what a person would have to edit.
  const ours = vendor.body.map((block) => blockText(block)).join('\n\n');
  const prompt = auditPrompt({
    vendor: vendor.vendor,
    name: vendor.name,
    ours,
    pageUrl: vendor.docs,
    pageText: page.text,
  });

  if (dryRun) {
    console.log(`[audit] would ask ${model} about ${vendor.vendor}: ${prompt.length} chars`);
    reviews.push(
      unreadable(vendor.vendor, `--dry-run: read ${page.text.length} characters, asked nothing`),
    );
    continue;
  }

  try {
    const raw = await backend.message({ system: AUDIT_SYSTEM, prompt });
    reviews.push(parseReview(extractJson(raw), vendor.vendor));
  } catch (err) {
    reviews.push(unreadable(vendor.vendor, `the model could not be asked — ${err.message}`));
  }
}

// Vendors `KEY_VENDORS` expects but the file does not carry are their own kind of finding, and
// one this run should not silently omit.
for (const expected of KEY_VENDORS) {
  if (!guide.vendors.some((v) => v.vendor === expected)) {
    reviews.push(unreadable(expected, 'docs/api-keys.md has no section for this vendor at all'));
  }
}

const review = renderReview(reviews, stamp());
await fs.writeFile(outPath, review, 'utf8');

for (const { vendor, verdict } of reviews) console.log(`[audit] ${vendor}: ${verdict}`);
console.log(`[audit] wrote ${outPath}`);

// Read by the workflow, which files an issue only when there is something to apply.
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, `drift=${hasDrift(reviews)}\n`);
}
