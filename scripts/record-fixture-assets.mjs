/**
 * Record — or audit — the fixture asset corpus in `packages/testkit/assets/`.
 *
 * `--check` is free and offline: it replays a fixture against the corpus and reports what was
 * reused, what nothing asked for, and what is indexed but missing on disk. Without it, the
 * script runs the fixture's image requests against the **real** Gemini model and writes the
 * responses back — a deliberate, costed, human-initiated action that needs a Gemini key.
 * Staleness is always reported and never gated; see `docs/plans/sample-workspace-and-asset-cache.md`.
 *
 * The logic lives in `packages/testkit/src/record.ts` so it is typechecked and covered by the
 * boundaries rule. Testkit is source-only TypeScript, so bundle it the way the command catalog
 * does and require the result.
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
const TMP = resolve(root, 'packages/testkit/.record-entry.cjs');

await build({
  entryPoints: [resolve(root, 'packages/testkit/src/record.ts')],
  outfile: TMP,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
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
  const report = await (check ? checkCorpus : recordCorpus)({ fixture, log });
  process.stdout.write(`${formatReport(report)}\n`);
} finally {
  await fs.rm(TMP, { force: true });
  await fs.rm(`${TMP}.map`, { force: true });
}
