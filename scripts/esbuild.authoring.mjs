/**
 * Bundle the `vnauthor` REPL into a single Node executable, mirroring the @vn/cli bundle
 * (plan §M4). Type checking is not done here — run `pnpm check` (tsgo) for that. The
 * authoring app deliberately pulls only input-side packages (no @vn/pipeline / scheduler),
 * which the boundaries lint rule enforces; a bundle script cannot, because it only ever sees
 * what was imported.
 *
 * Usage: `node scripts/esbuild.authoring.mjs [--watch]`
 */
import { build, context } from 'esbuild';
import { resolve } from 'node:path';
import { alias as shared, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const watch = process.argv.includes('--watch');

// The shared map, plus the one entry it cannot carry: it covers `packages/`, and this is an app.
const alias = { ...shared, '@vn/authoring-app': resolve(root, 'apps/authoring/src/index.ts') };

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(root, 'apps/authoring/src/vnauthor.ts')],
  outfile: resolve(root, 'apps/authoring/dist/vnauthor.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  alias,
  external: EXTERNAL,
  banner: {
    js: '#!/usr/bin/env node\nimport{createRequire}from"node:module";const require=createRequire(import.meta.url);',
  },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  process.stderr.write('esbuild: watching @vn/authoring-app…\n');
} else {
  await build(options);
}
