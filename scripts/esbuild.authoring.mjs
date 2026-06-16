/**
 * Bundle the `vnauthor` REPL into a single Node executable, mirroring the @vn/cli bundle
 * (plan §M4). Type checking is not done here — run `pnpm check` (tsgo) for that. The
 * authoring app deliberately pulls only input-side packages (no @vn/pipeline / scheduler);
 * the boundaries lint rule enforces that, this alias map just reflects it.
 *
 * Usage: `node scripts/esbuild.authoring.mjs [--watch]`
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const PACKAGES = [
  'types',
  'util',
  'config',
  'parse',
  'model',
  'store',
  'git',
  'providers',
  'authoring',
];
const alias = Object.fromEntries([
  ...PACKAGES.map((n) => [`@vn/${n}`, resolve(root, `packages/${n}/src/index.ts`)]),
  ['@vn/authoring-app', resolve(root, 'apps/authoring/src/index.ts')],
]);

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
  external: ['@google/genai', '@anthropic-ai/sdk'],
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
