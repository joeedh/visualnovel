import { join } from 'node:path';

/**
 * Where recorded fixture art lives: `packages/testkit/assets/`, `<key>.<ext>` beside an
 * `index.json`. Testkit-owned on purpose — **nothing may import `@vn/testkit`**, so the
 * corpus cannot leak into an app by accident. The desktop app needs no share of it: it gets
 * real art from its own seeded workspace, which is a real run.
 *
 * `__dirname` rather than `import.meta.url`: testkit runs under jest, whose esbuild transform
 * emits CJS per file, so `__dirname` is `packages/testkit/src` and this resolves correctly.
 * It does **not** survive bundling — esbuild rewrites `__dirname` to the *output* file's
 * directory, so a bundle placed anywhere else silently reads and writes the wrong corpus.
 * `scripts/record-fixture-assets.mjs` therefore passes `cacheDir` explicitly rather than
 * relying on this default.
 */
export const FIXTURE_ASSET_DIR = join(__dirname, '..', 'assets');
