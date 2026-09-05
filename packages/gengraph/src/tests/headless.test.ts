import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'esbuild';
import type { Plugin } from 'esbuild';

const REPO_ROOT = resolve(__dirname, '../../../..');

/** Resolves `@vn/x` and `@vn/x/entry` the way every bundle in this repo does. */
const vnPackages: Plugin = {
  name: 'vn-packages',
  setup(bundler) {
    bundler.onResolve({ filter: /^@vn\// }, (args) => {
      const [pkg, entry] = args.path.slice('@vn/'.length).split('/');
      if (pkg === undefined) {
        return undefined;
      }
      return { path: resolve(REPO_ROOT, `packages/${pkg}/src/${entry ?? 'index'}.ts`) };
    });
  },
};

const VENDOR_ALIAS = {
  'pathux-graph'     : resolve(REPO_ROOT, 'vendor/path.ux/scripts/graph/index.ts'),
  'pathux-toolprop': resolve(
    REPO_ROOT,
    'vendor/path.ux/scripts/path-controller/toolsys/toolprop.ts',
  ),
  'pathux-base-types': resolve(REPO_ROOT, 'vendor/path.ux/scripts/core/base/ui_base_types.ts'),
  nstructjs          : resolve(REPO_ROOT, 'vendor/nstructjs/build/nstructjs_es6.js'),
};

let outDir = '';

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'gengraph-headless-'));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * jest's node environment still leaves globals a browser bundle can lean on, so this
 * bundles the package and runs it in a bare node process instead. A DOM reference
 * anywhere under `@vn/gengraph` fails the run rather than passing unnoticed.
 */
it('loads, saves and validates a graph in a bare node process', async () => {
  const outfile = join(outDir, 'headless.cjs');

  await build({
    entryPoints: [resolve(__dirname, '__fixtures__/headless-entry.ts')],
    outfile,
    bundle   : true,
    platform : 'node',
    // CommonJS, because the bundle reaches CJS dependencies that an ESM output would
    // have to load through a require it cannot supply.
    format   : 'cjs',
    target   : 'node20',
    keepNames: true,
    alias    : VENDOR_ALIAS,
    plugins  : [vnPackages],
    logLevel : 'silent',
  });

  const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8' });

  expect(`${run.stdout}${run.stderr}`).toContain('GENGRAPH-HEADLESS-OK');
  expect(run.status).toBe(0);
}, 120_000);
