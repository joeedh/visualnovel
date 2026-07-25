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
  'git',
  'commands',
  'debug2d',
  'taskgraph',
  'providers',
  'pipeline',
  'scheduler',
  'authoring',
];

/** Electron is provided by the runtime; the model SDKs are heavy and lazy-imported. */
export const EXTERNAL = ['electron', '@google/genai', '@anthropic-ai/sdk'];

export const alias = Object.fromEntries(
  PACKAGES.map((n) => [`@vn/${n}`, resolve(REPO_ROOT, `packages/${n}/src/index.ts`)]),
);
