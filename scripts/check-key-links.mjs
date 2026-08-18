/**
 * Tier 1 of [`docs/plans/auditing-the-api-key-instructions.md`]: every URL `docs/api-keys.md`
 * states in a vendor's yaml block still resolves.
 *
 * This is the failure that actually happens to a new user. Both vendors reword and rearrange
 * their key pages without telling anyone, and instructions that were right when shipped and are
 * wrong a year later are worse than none — they are confidently wrong at the exact moment someone
 * has nothing else to go on. The words around a link drifting is tier 2's advisory problem; the
 * link itself moving is this one's, and its verdict is unambiguous enough to block CI.
 *
 * It reads the file through `parseKeyGuide`, the same reader the Setup pane uses, so the checker
 * and the pane cannot disagree about which sections exist or what a vendor block says. The verdict
 * for a pair of responses is `linkReport`, which is pure and has tests; everything here is the
 * plumbing around it — bundling the TypeScript, making the requests, retrying, and the report.
 *
 * Each URL is asked about twice: the page itself, and a sibling path that cannot exist. A host
 * that answers 200 to both has told us nothing, and that is reported as `unverified` rather than
 * dressed up as a pass — see `linkReport` for why one of our own six links is permanently in that
 * state.
 *
 * Usage:
 *   node scripts/check-key-links.mjs          # exits non-zero if any link is broken
 *
 * It never writes to `docs/api-keys.md`. Nothing in either tier of this audit does: that file is
 * what a new user reads when they are most confused and least able to tell something is wrong.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const GUIDE = join(root, 'docs/api-keys.md');
const TMP = resolve(root, 'apps/desktop/.keylinks-entry.cjs');

/** How many times a request is allowed to be ordinary network noise before it is a verdict. */
const ATTEMPTS = 3;
const RETRY_MS = 2000;
/** Long enough for a slow vendor page, short enough that a hung CI job still ends. */
const TIMEOUT_MS = 20_000;

/**
 * Some vendor edges answer 403 to anything that does not look like a browser, and a link check
 * that reported that as a dead link would be reporting on its own user agent.
 */
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'accept-language': 'en',
};

await build({
  stdin: {
    contents: [
      "export { KEY_VENDORS } from '@vn/config';",
      'export { canaryFor, guideUrls, keyGuideProblems, linkReport, parseKeyGuide }',
      "  from './apps/desktop/src/shared/apikeys.js';",
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

const { KEY_VENDORS, canaryFor, guideUrls, keyGuideProblems, linkReport, parseKeyGuide } =
  createRequire(import.meta.url)(TMP);
await fs.rm(TMP, { force: true });

const guide = parseKeyGuide(await fs.readFile(GUIDE, 'utf8'));

// The shape of the file is checked before the network is touched. A missing yaml block is a
// broken page too, and finding it here says so in one line rather than as an absence of URLs.
const problems = keyGuideProblems(guide, KEY_VENDORS);
for (const problem of problems) console.error(`FAIL docs/api-keys.md — ${problem}`);

/** One request, with a timeout, reduced to what {@link linkReport} needs to judge it. */
async function ask(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: HEADERS,
      signal: abort.signal,
    });
    return { status: response.status, finalUrl: response.url };
  } catch (err) {
    return {
      error: err.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000}s` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The retry, which is the difference between a check people trust and one they learn to re-run.
 * Two extra attempts, spaced, and the third answer is the verdict.
 *
 * The canary rides along on every attempt rather than being asked once up front, because the two
 * answers are only comparable if they came from the same host in the same mood. They go out
 * together for the same reason: a host that started refusing between the two calls would otherwise
 * look like a host that answers everything.
 */
async function check(url) {
  let report;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const [outcome, canary] = await Promise.all([ask(url), ask(canaryFor(url))]);
    report = linkReport(url, outcome, canary);
    if (report.state !== 'broken') return report;
    if (attempt < ATTEMPTS) await sleep(RETRY_MS * attempt);
  }
  return report;
}

const MARK = { ok: 'ok  ', unverified: '?   ', broken: 'FAIL' };

let broken = problems.length > 0;
let unverified = 0;
for (const { vendor, field, url } of guideUrls(guide)) {
  const report = await check(url);
  // The vendor and the field first, because that is what someone has to go and edit.
  const line = `${MARK[report.state]} ${vendor} ${field} — ${url} (${report.detail})`;
  if (report.state === 'broken') {
    console.error(line);
    broken = true;
  } else {
    console.log(line);
    if (report.state === 'unverified') unverified++;
  }
}

if (broken) {
  console.error(
    '\nA link in docs/api-keys.md no longer resolves. Find the vendor’s current page and edit ' +
      'that file — it is the only copy, so the Setup pane is fixed by the same edit.',
  );
  process.exit(1);
}

console.log('\nEvery link in docs/api-keys.md resolves.');
if (unverified > 0) {
  // Said every run, not just the first, because the number going up is the signal. One vendor
  // hiding its console behind a sign-in is a fact about that vendor; a second one doing it means
  // this check is quietly stopping being a check, and nobody would notice from a green tick.
  console.log(
    `${unverified} of them could not really be checked — the host answers everything, so the ` +
      'link is only known to be pointing somewhere that is up. Read those by eye now and then.',
  );
}
