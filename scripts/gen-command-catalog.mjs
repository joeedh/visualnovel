/**
 * Emit the build-time command catalog: `apps/desktop/dist/commands.json`.
 *
 * The registry is TypeScript in a source-only workspace, so there is nothing to `import`
 * directly — bundle `catalog-entry.ts` to a throwaway CJS file with the same aliases the app
 * bundle uses, require it, and write what it returns. The `command:catalog` IPC channel
 * serves the LIVE registry, never this file, so the two can't diverge at runtime; this is
 * for external tooling that has no running app.
 *
 * Usage: `node scripts/gen-command-catalog.mjs`
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const OUT = resolve(root, 'apps/desktop/dist/commands.json');
const TMP = resolve(root, 'apps/desktop/dist/.commands-entry.cjs');

await build({
  entryPoints: [resolve(root, 'apps/desktop/src/main/commands/catalog-entry.ts')],
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
  const { catalog } = createRequire(import.meta.url)(TMP);
  const json = catalog();
  await fs.writeFile(OUT, JSON.stringify(json, null, 2) + '\n');
  process.stderr.write(`commands.json: ${json.commands.length} command(s)\n`);
} finally {
  await fs.rm(TMP, { force: true });
  await fs.rm(`${TMP}.map`, { force: true });
}
