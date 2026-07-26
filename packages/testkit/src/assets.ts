import { join } from 'node:path';

/**
 * Where recorded fixture art lives: `packages/testkit/assets/`, `<key>.<ext>` beside an
 * `index.json`. Testkit-owned on purpose — **nothing may import `@vn/testkit`**, so the
 * corpus cannot leak into an app by accident. The desktop app needs no share of it: it gets
 * real art from its own seeded workspace, which is a real run.
 *
 * `__dirname` rather than `import.meta.url`: testkit only ever runs under jest, whose
 * esbuild transform emits CJS, and the recorder script bundles it the same way.
 */
export const FIXTURE_ASSET_DIR = join(__dirname, '..', 'assets');
