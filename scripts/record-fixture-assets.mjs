/**
 * Record — or audit — the fixture asset corpus in `packages/testkit/assets/`.
 *
 * `--check` is free and offline: it replays a fixture against the corpus and reports what was
 * reused, what nothing asked for, and what is indexed but missing on disk. Without it, the
 * script runs the fixture's image requests against the **real** Gemini model and writes the
 * responses back — a deliberate, costed, human-initiated action that needs a Gemini key.
 * Staleness is always reported and never gated; see `docs/plans/archive/INDEX.md#sample-workspace-and-asset-cache`.
 *
 * The logic lives in `packages/testkit/src/record.ts` so it is typechecked and covered by the
 * boundaries rule. Testkit is source-only TypeScript, so bundle it the way the command catalog
 * does and require the result. The bundle is emitted into **`packages/providers`**, not
 * testkit: the model SDKs are `EXTERNAL` and lazy-imported, and `@google/genai` is a dependency
 * of `@vn/providers` alone — from anywhere else node cannot resolve it and every image task
 * fails at the moment the backend is first touched.
 *
 * Usage:
 *   node scripts/record-fixture-assets.mjs --check [--fixture linear]
 *   node scripts/record-fixture-assets.mjs --fixture linear      # costs money
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const at = argv.indexOf('--fixture');
const fixture = at >= 0 ? argv[at + 1] : 'linear';
const TMP = resolve(root, 'packages/providers/.record-entry.cjs');

await build({
  entryPoints: [resolve(root, 'packages/testkit/src/record.ts')],
  outfile    : TMP,
  bundle     : true,
  platform   : 'node',
  format     : 'cjs',
  target     : 'node20',
  alias,
  external: EXTERNAL,
  logLevel: 'warning',
});

try {
  const { recordCorpus, checkCorpus, formatReport } = createRequire(import.meta.url)(TMP);
  const log = (line) => process.stderr.write(`${line}\n`);
  if (!check) {
    log('This calls the real image model and will be billed. Ctrl-C within 5s to abort.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  // Explicit, because `FIXTURE_ASSET_DIR` is `__dirname`-relative and esbuild rewrites that to
  // the bundle's directory — the default would resolve somewhere adjacent and plausible.
  const cacheDir = resolve(root, 'packages/testkit/assets');
  const report = await (check ? checkCorpus : recordCorpus)({ fixture, cacheDir, log });
  process.stdout.write(`${formatReport(report)}\n`);
  // Staleness is reported, never gated — but a task that *failed* means the run recorded less
  // than it was asked to, and on the paid path that must not read as success.
  if (report.failed.length) process.exitCode = 1;
} finally {
  await fs.rm(TMP, { force: true });
  await fs.rm(`${TMP}.map`, { force: true });
}
