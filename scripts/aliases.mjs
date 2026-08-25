/**
 * The esbuild alias map from `@vn/*` to package sources, shared by every bundle script.
 *
 * Internal packages are source-only (no per-package `dist`, CLAUDE.md § Toolchain notes), so
 * each bundler needs to point `@vn/x` at `packages/x/src/index.ts` itself. Keeping the list
 * here means `esbuild.desktop.mjs` and `gen-command-catalog.mjs` can't drift apart.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES = [
  'types',
  'util',
  'config',
  'parse',
  'model',
  'store',
  'export',
  'scriptedit',
  'git',
  'commands',
  'debug2d',
  'taskgraph',
  'providers',
  'pipeline',
  'scheduler',
  'authoring',
  'gengraph',
];

/** Electron is provided by the runtime; the model SDKs are heavy and lazy-imported. */
export const EXTERNAL = ['electron', '@google/genai', '@anthropic-ai/sdk'];

/**
 * Subpath exports, which esbuild can't derive from the list above. A subpath names its source
 * file, so `@vn/scriptedit/write` is `packages/scriptedit/src/write.ts`.
 */
const SUBPATHS = ['scriptedit/write', 'gengraph/state'];

export const alias = Object.fromEntries([
  ...PACKAGES.map((n) => [`@vn/${n}`, resolve(REPO_ROOT, `packages/${n}/src/index.ts`)]),
  ...SUBPATHS.map((p) => {
    const [pkg, entry] = p.split('/');
    return [`@vn/${p}`, resolve(REPO_ROOT, `packages/${pkg}/src/${entry}.ts`)];
  }),
  // @vn/gengraph's door to path.ux's graph module and the ToolProperty classes node
  // specs are authored with (the graph module does not re-export them). Where code is
  // only type-checked, the root tsconfig maps the same names to declarations emitted
  // by the desktop app's build:pathux-types pass.
  ['pathux-graph', resolve(REPO_ROOT, 'vendor/path.ux/scripts/graph/index.ts')],
  [
    'pathux-toolprop',
    resolve(REPO_ROOT, 'vendor/path.ux/scripts/path-controller/toolsys/toolprop.ts'),
  ],
  // Pinned to the vendored submodule so one nstructjs STRUCT registry serves both
  // path.ux and this repo; a second copy would register nothing path.ux's classes use.
  ['nstructjs', resolve(REPO_ROOT, 'vendor/nstructjs/build/nstructjs_es6.js')],
]);
