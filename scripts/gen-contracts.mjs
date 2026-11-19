/**
 * Regenerate the contract index from every package's and app's `contracts.ts`
 * (`docs/plans/contracts-into-code-and-workflows.md`, "The index"): the summary file,
 * `packages/contracts/contracts.json`, and one shard per area of full records,
 * `packages/contracts/contracts/<area>.json`. The files are committed, and
 * `scripts/contracts/tests/index.test.ts` fails when they no longer equal a fresh run, so this is
 * the step to run after declaring or editing a contract.
 *
 * Usage: `pnpm gen:contracts`
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { loadEntry } from './lib/load-entry.mjs';

const SUMMARY = resolve(root, 'packages/contracts/contracts.json');
const SHARDS = resolve(root, 'packages/contracts/contracts');
const SUMMARY_BYTES = 100 * 1024;

const { summary, shards } = await loadEntry('scripts/contracts/entry.ts', 'contractFiles', root);
await fs.mkdir(SHARDS, { recursive: true });
const written = [SUMMARY];
await fs.writeFile(SUMMARY, JSON.stringify(summary, null, 2) + '\n');
for (const [area, shard] of Object.entries(shards)) {
  const file = resolve(SHARDS, `${area}.json`);
  await fs.writeFile(file, JSON.stringify(shard, null, 2) + '\n');
  written.push(file);
}

// `pnpm lint` checks these files' formatting like any other
execFileSync('pnpm', ['exec', 'prettier', '--write', ...written], {
  cwd  : root,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});

const kb = async (file) => Math.round((await fs.stat(file)).size / 1024);
const sizes = await Promise.all(
  Object.keys(shards).map(async (area) => `${area} ${await kb(resolve(SHARDS, `${area}.json`))}`),
);
const bytes = (await fs.stat(SUMMARY)).size;
process.stdout.write(
  `contracts.json: ${summary.contracts.length} contracts, ` +
    `${Object.keys(summary.bySubject).length} subjects, ${Math.round(bytes / 1024)} KB\n` +
    `contracts/<area>.json, KB: ${sizes.join(', ')}\n`,
);
if (bytes > SUMMARY_BYTES) {
  process.stderr.write(
    `contracts.json is over ${SUMMARY_BYTES / 1024} KB even as summaries, so a model reading it ` +
      'reads more than the plan budgets for.\n',
  );
}
