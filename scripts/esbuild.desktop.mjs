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
import { resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';
import { sitebuilderOptions } from './esbuild.sitebuilder.mjs';

const watch = process.argv.includes('--watch');

/** Shared options; only entry/outfile differ between main and preload. */
const common = {
  bundle   : true,
  platform : 'node',
  format   : 'cjs',
  target   : 'node20',
  sourcemap: true,
  alias,
  external: EXTERNAL,
  logLevel: 'info',
};

const targets = [
  {
    entryPoints: [resolve(root, 'apps/desktop/src/main/index.ts')],
    outfile    : resolve(root, 'apps/desktop/dist/main/index.cjs'),
  },
  {
    entryPoints: [resolve(root, 'apps/desktop/src/preload/index.ts')],
    outfile    : resolve(root, 'apps/desktop/dist/preload/index.cjs'),
  },
];

// The site builder is bundled here too, with its own options rather than `common`: it is ESM,
// has no externals, and ships into an author's git repository. Building it alongside main means
// the dev watcher and `pnpm build:main` both leave a current copy where `pages.ts` looks for it.
const all = [...targets.map((t) => ({ ...common, ...t })), sitebuilderOptions];

if (watch) {
  for (const options of all) {
    const ctx = await context(options);
    await ctx.watch();
  }
  process.stderr.write('esbuild: watching @vn/desktop (main + preload + site builder)…\n');
} else {
  await Promise.all(all.map((options) => build(options)));
}
