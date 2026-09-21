/**
 * Bundle a `.ts` entrypoint (in a source-only workspace, so there is nothing to `import`
 * directly) to a throwaway CJS file with the same aliases the app bundle uses, `require` it,
 * and return the named export called with `args`. Shared by `gen-command-catalog.mjs`,
 * `gen-command-table.mjs`, `gen-ux-model.mjs` and `gen-ux-docs.mjs` so the esbuild invocation
 * can't drift between them.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from '../aliases.mjs';

export async function loadEntry(entryPoint, exportName, ...args) {
  const tmp = resolve(root, `apps/desktop/dist/.${exportName}-entry.cjs`);
  await build({
    entryPoints: [resolve(root, entryPoint)],
    outfile    : tmp,
    bundle     : true,
    platform   : 'node',
    format     : 'cjs',
    target     : 'node20',
    alias,
    external: EXTERNAL,
    logLevel: 'warning',
  });

  try {
    const mod = createRequire(import.meta.url)(tmp);
    return mod[exportName](...args);
  } finally {
    await fs.rm(tmp, { force: true });
    await fs.rm(`${tmp}.map`, { force: true });
  }
}
