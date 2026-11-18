/**
 * Regenerate the contract index, `packages/contracts/contracts.json`, from every package's and
 * app's `contracts.ts` (`docs/plans/contracts-into-code-and-workflows.md`, "The index"). The file
 * is committed, and `scripts/contracts/tests/index.test.ts` fails when it no longer equals a fresh
 * run, so this is the step to run after declaring or editing a contract.
 *
 * Usage: `pnpm gen:contracts`
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { loadEntry } from './lib/load-entry.mjs';

const OUT = resolve(root, 'packages/contracts/contracts.json');
const SHARD_BYTES = 100 * 1024;

const index = await loadEntry('scripts/contracts/entry.ts', 'contractIndex', root);
await fs.writeFile(OUT, JSON.stringify(index, null, 2) + '\n');

// `pnpm lint` checks this file's formatting like any other
execFileSync('pnpm', ['exec', 'prettier', '--write', OUT], {
  cwd  : root,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});

const bytes = (await fs.stat(OUT)).size;
process.stdout.write(
  `contracts.json: ${index.contracts.length} contracts, ` +
    `${Object.keys(index.bySubject).length} subjects, ${Math.round(bytes / 1024)} KB\n`,
);
if (bytes > SHARD_BYTES) {
  process.stderr.write(
    `contracts.json is over ${SHARD_BYTES / 1024} KB; the plan splits it into a summary file and ` +
      'one shard per area at this size.\n',
  );
}
