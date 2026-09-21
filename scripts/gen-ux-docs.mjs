/**
 * Write the UX docs tree the authoring agent reads, `apps/desktop/dist/ux/`, from the derived UX
 * model, the anchor sweep and the command registry (`docs/plans/agent-reads-the-ux-model.md`).
 * The tree ships inside `dist/` and is never committed: `ux-model.json` is the committed
 * derivative, and this is a rendering of it.
 *
 * Runs as `build:uxdocs` in `apps/desktop/package.json` and at the start of `dev.desktop.mjs`.
 *
 * Usage: `node scripts/gen-ux-docs.mjs`
 */
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { loadEntry } from './lib/load-entry.mjs';

const OUT = resolve(root, 'apps/desktop/dist/ux');

const model = await loadEntry('apps/desktop/renderer/rules/model-entry.ts', 'model');
const anchors = JSON.parse(await fs.readFile(resolve(root, 'apps/desktop/anchors.json'), 'utf8'));
const pages = await loadEntry(
  'apps/desktop/src/main/commands/uxdocs-entry.ts',
  'uxPages',
  model,
  anchors,
);

// Whole rather than in place, so a page for a command that no longer exists does not linger
await fs.rm(OUT, { recursive: true, force: true });
for (const [path, text] of pages) {
  const file = resolve(OUT, path);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
process.stdout.write(`dist/ux: ${pages.size} pages\n`);
