/**
 * The ONE place runtime transpilation happens (plan §5): bundle @vn/cli into a single
 * Node executable, pulling every workspace package from source and tree-shaking. Type
 * checking is not done here — run `pnpm check` (tsgo) for that.
 *
 * Usage: `node scripts/esbuild.cli.mjs [--watch]`
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

// Resolve @vn/* straight to package source, independent of node_modules symlinks.
const PACKAGES = [
  'types',
  'util',
  'config',
  'parse',
  'model',
  'store',
  'taskgraph',
  'providers',
  'pipeline',
  'scheduler',
];
const alias = Object.fromEntries([
  ...PACKAGES.map((n) => [`@vn/${n}`, resolve(root, `packages/${n}/src/index.ts`)]),
  ['@vn/cli', resolve(root, 'apps/cli/src/index.ts')],
]);

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
  // SDKs that ship platform binaries / heavy native deps stay external.
  external: ['@google/genai', '@anthropic-ai/sdk'],
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
