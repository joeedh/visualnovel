/**
 * Regenerate the derived UX model, `apps/desktop/ux-model.json`, from the rule modules and their
 * situations (`docs/reference/guided-tours.md`, Part III). The file is committed, and
 * `apps/desktop/renderer/rules/tests/model.test.ts` fails when it no longer equals a fresh run, so
 * this is the step to run after touching `apps/desktop/renderer/rules/**`.
 *
 * Usage: `pnpm gen:uxmodel`
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { loadEntry } from './lib/load-entry.mjs';

const OUT = resolve(root, 'apps/desktop/ux-model.json');

const model = await loadEntry('apps/desktop/renderer/rules/model-entry.ts', 'model');
await fs.writeFile(OUT, JSON.stringify(model, null, 2) + '\n');

// `pnpm lint` checks this file's formatting like any other, and `JSON.stringify` breaks every
// array across lines where prettier would keep a short one inline.
execFileSync('pnpm', ['exec', 'prettier', '--write', OUT], {
  cwd  : root,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});

const anchored = new Set(
  model.records.map((record) => (record.via === 'control' ? record.offer.id : record.id)),
);
process.stdout.write(
  `ux-model.json: ${model.situations.length} situations, ${model.records.length} records, ` +
    `${anchored.size} commands with a control, ${model.paletteOnly.length} palette-only entries\n`,
);
