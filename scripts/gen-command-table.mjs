/**
 * Generate the two command-reference tables from the live registry: the flat list
 * (`docs/reference/command-table.md`) and the per-namespace breakdown
 * (`docs/reference/command-namespaces.md`). `docs/reference/command-system.md` links to both
 * rather than carrying them inline, so neither can drift from what is actually registered.
 *
 * Usage: `node scripts/gen-command-table.mjs`
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { loadEntry } from './lib/load-entry.mjs';
import { buildCommandTables } from './lib/command-table.mjs';

const entries = await loadEntry('apps/desktop/src/main/commands/doc-entry.ts', 'docIndex');
const { flatFile, namespaceFile } = buildCommandTables(entries);

await fs.writeFile(resolve(root, 'docs/reference/command-table.md'), flatFile);
await fs.writeFile(resolve(root, 'docs/reference/command-namespaces.md'), namespaceFile);
process.stderr.write(`command-table.md + command-namespaces.md: ${entries.length} command(s)\n`);
