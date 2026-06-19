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
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: { port: 5176 },
});
