/**
 * The ONE place runtime transpilation happens (plan §5): bundle @vn/cli into a single
 * Node executable, pulling every workspace package from source and tree-shaking. Type
 * checking is not done here — run `pnpm check` (tsgo) for that.
 *
 * Usage: `node scripts/esbuild.cli.mjs [--watch]`
 */
import { build, context } from 'esbuild';
import { resolve } from 'node:path';
import { alias as shared, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const watch = process.argv.includes('--watch');

// The shared map, plus the one entry it cannot carry: it covers `packages/`, and the CLI is an
// app. This script used to keep a list of its own, which went stale the first time a package the
// CLI bundles grew a dependency outside that list.
const alias = { ...shared, '@vn/cli': resolve(root, 'apps/cli/src/index.ts') };

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(root, 'apps/cli/src/cli.ts')],
  outfile: resolve(root, 'apps/cli/dist/cli.js'),
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
  process.stderr.write('esbuild: watching @vn/cli…\n');
} else {
  await build(options);
}
