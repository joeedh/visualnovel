import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Renderer-only Vite build. The renderer lives at `apps/desktop/renderer` (outside the
 * `src` tree) so the root `tsgo` check never sees its JSX; the renderer typechecks against
 * its own `renderer/tsconfig.json`.
 *
 * `base: './'` makes the built `index.html` load its assets by relative path, so Electron
 * can open it from `file://` in production.
 */
export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // path.ux is a git submodule compiled from source, not a pnpm workspace member —
      // one build pipeline, no prebuilt `dist/pathux.js` to keep in sync. `nstructjs` is
      // its only runtime dependency, pinned here so it resolves to the copy this app
      // installs rather than whichever one node resolution finds above `vendor/`.
      pathux: resolve(__dirname, '../../vendor/path.ux/scripts/pathux.ts'),
      nstructjs: resolve(__dirname, 'node_modules/nstructjs'),
    },
  },
  // path.ux uses auto-accessor fields (`accessor x = 1`), which rollup's parser cannot read.
  // Naming a target below esnext is what makes esbuild lower them to a getter/setter pair
  // before rollup ever sees the file; Electron 33 is Chrome 130, so es2022 costs nothing.
  esbuild: { target: 'es2022' },
  build: {
    target: 'es2022',
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: { port: 5176 },
});
