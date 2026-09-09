/**
 * Serves stored asset bytes to the renderer over `vnasset://<hash>.<ext>` — the app's only
 * image-loading path.
 */
import { protocol } from 'electron';
import { ProjectPaths } from '@vn/store';
import type { AppContext } from '../runtime/context.js';
import { fileCache } from '../workspace/filecache.js';

/**
 * Serve stored asset bytes to the renderer over `vnasset://<hash>.<ext>` — the app's only
 * image-loading path. The url host carries `<hash>.<ext>` (sha256 hashes are lowercase hex, so
 * the standard-scheme host lowercasing is harmless). A missing file simply fails the request and
 * the caller falls back to a placeholder.
 *
 * Both roots are searched, in the order `AssetStore` reads them: base art (portraits, model
 * sheets, location plates) lives beside the inputs at `assets/objects/`, and only shot frames are
 * under `vngen/build/assets/`. A url says nothing about which root it came from, and the backlink
 * panel's images are entirely the base kind (`docs/reference/asset-stores.md`).
 *
 * The root is resolved per request, not captured: after `switchWorkspace` a captured one would
 * serve the previous project's bytes at the new project's hashes.
 *
 * Bytes come from the file cache, which never has to revalidate them: a stored asset's name is
 * the hash of its own contents, so the file at a given path either holds those bytes or does not
 * exist. A request the cache answers touches no disk at all, which is what makes a gallery of
 * forty thumbnails redraw without forty reads.
 */
export function registerAssetProtocol(ctx: AppContext): void {
  protocol.handle('vnasset', async (request) => {
    const host = new URL(request.url).hostname;
    const dot = host.lastIndexOf('.');
    const hash = dot > 0 ? host.slice(0, dot) : host;
    const ext = dot > 0 ? host.slice(dot + 1) : 'png';
    const paths = new ProjectPaths(ctx.workspace());
    for (const file of [paths.baseAssetFile(hash, ext), paths.assetFile(hash, ext)]) {
      const bytes = await fileCache.asset(file).catch(() => null);
      if (bytes) return new Response(bytes, { headers: { 'content-type': assetType(ext) } });
    }
    // A missing file simply fails the request, and the caller falls back to a placeholder.
    return new Response(null, { status: 404 });
  });
}

/** What `<img>` and `fetch` are told a stored asset is, from the extension its name carries. */
export function assetType(ext: string): string {
  const known: Record<string, string> = {
    png : 'image/png',
    jpg : 'image/jpeg',
    jpeg: 'image/jpeg',
    gif : 'image/gif',
    webp: 'image/webp',
    svg : 'image/svg+xml',
  };
  return known[ext.toLowerCase()] ?? 'application/octet-stream';
}
