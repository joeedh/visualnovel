/**
 * Emit the build-time command catalog: `apps/desktop/dist/commands.json`.
 *
 * The `command:catalog` IPC channel serves the LIVE registry, never this file, so the two
 * can't diverge at runtime; this is for external tooling that has no running app.
 *
 * Usage: `node scripts/gen-command-catalog.mjs`
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { loadEntry } from './lib/load-entry.mjs';

const OUT = resolve(root, 'apps/desktop/dist/commands.json');

const json = await loadEntry('apps/desktop/src/main/commands/catalog-entry.ts', 'catalog');
await fs.writeFile(OUT, JSON.stringify(json, null, 2) + '\n');
process.stderr.write(`commands.json: ${json.commands.length} command(s)\n`);
