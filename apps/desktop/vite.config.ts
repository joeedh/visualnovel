import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Renderer-only Vite build. The renderer lives at `apps/desktop/renderer` (outside the
 * `src` tree) so the root `tsgo` check never sees its JSX; the renderer typechecks against
 * its own `renderer/tsconfig.json`.
 *
 * `base: './'` makes the built `index.html` load its assets by relative path, so Electron
 * can open it from `file://` in production.
 */
export default defineConfig({
  root   : resolve(__dirname, 'renderer'),
  base   : './',
  resolve: {
    alias: {
      // path.ux is a git submodule compiled from source rather than a pnpm workspace member, so
      // there is no prebuilt `dist/pathux.js`. `nstructjs` is its only runtime dependency and is
      // a submodule too; the alias covers path.ux's own imports, which would otherwise resolve to
      // the npm copy in `vendor/path.ux/node_modules`
      pathux             : resolve(__dirname, '../../vendor/path.ux/scripts/pathux.ts'),
      // @vn/gengraph's door to the graph module and the ToolProperty classes node specs
      // are authored with; the same names resolve to declarations in the root tsconfig.
      'pathux-graph'     : resolve(__dirname, '../../vendor/path.ux/scripts/graph/index.ts'),
      'pathux-toolprop': resolve(
        __dirname,
        '../../vendor/path.ux/scripts/path-controller/toolsys/toolprop.ts',
      ),
      'pathux-base-types': resolve(
        __dirname,
        '../../vendor/path.ux/scripts/core/base/ui_base_types.ts',
      ),
      nstructjs          : resolve(__dirname, '../../vendor/nstructjs'),
    },
  },
  // path.ux uses auto-accessor fields (`accessor x = 1`), which rollup's parser cannot read.
  // Naming a target below esnext is what makes esbuild lower them to a getter/setter pair
  // before rollup ever sees the file; Electron 33 is Chrome 130, so es2022 costs nothing.
  esbuild: { target: 'es2022' },
  build: {
    target     : 'es2022',
    outDir     : resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Vite defaults this off, which leaves the renderer as the one bundle DevTools cannot map
    // back to source; the main and preload bundles have carried maps all along.
    sourcemap  : true,
  },
  server : { port: 5176 },
});
