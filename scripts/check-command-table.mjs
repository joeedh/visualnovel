/**
 * Verify `docs/reference/command-table.md` and `docs/reference/command-namespaces.md` match what
 * `scripts/gen-command-table.mjs` would generate right now, so the two can't silently drift from
 * the live command registry the way the hand-maintained table they replaced already had.
 *
 * Read-only: builds the expected content in memory and only compares.
 *
 * Usage: `node scripts/check-command-table.mjs`  (exits non-zero naming the stale file(s))
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { loadEntry } from './lib/load-entry.mjs';
import { buildCommandTables } from './lib/command-table.mjs';

const FILES = {
  'docs/reference/command-table.md'     : 'flatFile',
  'docs/reference/command-namespaces.md': 'namespaceFile',
};

const entries = await loadEntry('apps/desktop/src/main/commands/doc-entry.ts', 'docIndex');
const expected = buildCommandTables(entries);

const stale = [];
for (const [rel, key] of Object.entries(FILES)) {
  const onDisk = await fs.readFile(resolve(root, rel), 'utf8').catch(() => null);
  if (onDisk !== expected[key]) stale.push(rel);
}

if (stale.length) {
  process.stderr.write(
    `${stale.join(', ')} out of date — run \`pnpm gen:command-table\` and commit the result.\n`,
  );
  process.exit(1);
}
process.stderr.write('check-command-table: up to date\n');
