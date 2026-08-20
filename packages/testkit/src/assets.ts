import { join } from 'node:path';

/**
 * Where recorded fixture art lives: `packages/testkit/assets/`, one `<key>.<ext>` per recording
 * beside an `index.json`. The corpus is owned by testkit because nothing may import
 * `@vn/testkit`, so it cannot leak into an app by accident. The desktop app does not need a
 * share of it; it gets real art from its own seeded workspace, which is a real run.
 *
 * This uses `__dirname` rather than `import.meta.url` because testkit runs under jest, whose
 * esbuild transform emits CJS per file, so `__dirname` is `packages/testkit/src` and resolves
 * correctly. That does not survive bundling: esbuild rewrites `__dirname` to the output file's
 * directory, so a bundle placed elsewhere silently reads and writes the wrong corpus.
 * `scripts/record-fixture-assets.mjs` therefore passes `cacheDir` explicitly rather than
 * relying on this default.
 */
export const FIXTURE_ASSET_DIR = join(__dirname, '..', 'assets');
