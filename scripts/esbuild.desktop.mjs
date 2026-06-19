/**
 * Bundle the Electron desktop app's Node-side entrypoints — the main process and the
 * preload — mirroring the @vn/cli / @vn/authoring bundles (CLAUDE.md "esbuild transpiles;
 * tsgo verifies"). The renderer is built separately by Vite (`vite build`).
 *
 * `apps/desktop` is the JOIN POINT above both the pipeline branch (@vn/scheduler) and the
 * authoring branch (@vn/authoring); it is the one place allowed to alias both (the
 * boundaries lint rule enforces that authoring itself never reaches the pipeline).
 *
 * Both entrypoints are bundled as CommonJS: Electron's main + preload run most reliably as
 * CJS (real __dirname, no ESM/loader friction), even though the workspace is otherwise ESM.
 *
 * Usage: `node scripts/esbuild.desktop.mjs [--watch]`
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
  'taskgraph',
  'providers',
  'pipeline',
  'scheduler',
  'authoring',
];
const alias = Object.fromEntries(
  PACKAGES.map((n) => [`@vn/${n}`, resolve(root, `packages/${n}/src/index.ts`)]),
);

/** Shared options; only entry/outfile differ between main and preload. */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  alias,
  // Electron is provided by the runtime; the SDKs ship heavy/native bits and are
  // lazy-imported by @vn/providers, so they stay external (only loaded on a real run).
  external: ['electron', '@google/genai', '@anthropic-ai/sdk'],
  logLevel: 'info',
};

const targets = [
  {
    entryPoints: [resolve(root, 'apps/desktop/src/main/index.ts')],
    outfile: resolve(root, 'apps/desktop/dist/main/index.cjs'),
  },
  {
    entryPoints: [resolve(root, 'apps/desktop/src/preload/index.ts')],
    outfile: resolve(root, 'apps/desktop/dist/preload/index.cjs'),
  },
];

if (watch) {
  for (const t of targets) {
    const ctx = await context({ ...common, ...t });
    await ctx.watch();
  }
  process.stderr.write('esbuild: watching @vn/desktop (main + preload)…\n');
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
}
