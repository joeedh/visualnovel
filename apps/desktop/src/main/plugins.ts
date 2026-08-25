/**
 * Activating installed plugins at startup, and the bundler that builds one.
 *
 * `@vn/gengraph` takes its bundler as an argument rather than depending on a build tool, so
 * this module is where the app decides which esbuild build does the work. It is the native
 * package. Both builds drive a child process, and the wasm one drives it by running `node`,
 * which a packaged app cannot assume is installed; the native one spawns a binary it ships
 * beside itself. `apps/desktop/electron-builder.yml` unpacks that binary and records why.
 */
import { activateInstalledPlugins, esbuildPluginBundler } from '@vn/gengraph/state';
import type { GenEsbuild, GenPluginBundler, GenPluginManifest } from '@vn/gengraph/state';
import { app } from 'electron';
import { join } from 'node:path';

import { notify } from './notifications.js';

let esbuildPromise: Promise<GenEsbuild> | undefined;

/**
 * Point esbuild at the binary electron-builder unpacked, which it cannot find on its own: it
 * derives the path from its own file, and its own file is inside the asar. Electron does not
 * redirect a spawn through the unpacked tree the way it redirects a read, so the spawn fails
 * with ENOENT. `ESBUILD_BINARY_PATH` is esbuild's own override for exactly this.
 *
 * The layout is the one `apps/desktop/electron-builder.yml`'s `asarUnpack` entry produces. A
 * development run resolves the binary through node_modules and needs none of this.
 */
export function pointAtUnpackedBinary(): void {
  if (!app.isPackaged || process.env['ESBUILD_BINARY_PATH']) return;
  const exe = process.platform === 'win32' ? 'esbuild.exe' : join('bin', 'esbuild');
  process.env['ESBUILD_BINARY_PATH'] = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    exe,
  );
}

/**
 * The first call starts a child process that then stays up, so the import is deferred until a
 * plugin actually needs building. A machine with no plugin installed never starts it.
 */
function lazyBundler(): GenPluginBundler {
  return async (entryFile) => {
    if (!esbuildPromise) {
      pointAtUnpackedBinary();
      esbuildPromise = import('esbuild').then((mod) => mod as unknown as GenEsbuild);
    }
    return esbuildPluginBundler(await esbuildPromise)(entryFile);
  };
}

/** The bundler every plugin in this process is built with. */
export const pluginBundler = lazyBundler();

/**
 * Activates every installed plugin and files a notification for each refusal. Called before
 * the first window, because a graph read after this point looks its node types up in the
 * registry these registrations land in.
 */
export async function activatePlugins(): Promise<GenPluginManifest[]> {
  const { loaded, refused } = await activateInstalledPlugins(pluginBundler);
  for (const reason of refused) {
    void notify({
      category: 'error',
      level: 'warn',
      source: 'main',
      message: `A generation plugin did not load: ${reason}`,
    });
  }
  return loaded;
}
