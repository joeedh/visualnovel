/**
 * Decoding a stored asset into a thumbnail the gallery widget can draw, and projecting a manifest
 * row into the widget's `GalleryItem` contract. The widget's `ThumbnailCache` is loader-agnostic
 * on purpose, so the `vnasset://` half lives here, in the one host that has that protocol.
 */
import type { GalleryItem } from 'pathux';
import type { AssetListing } from '../../src/shared/ipc.js';

/** Widest edge a decoded thumbnail is allowed. */
const THUMB_WIDTH = 256;

/** The url the main process's `vnasset` handler answers with the stored bytes. */
export function assetThumbUrl(hash: string, ext: string): string {
  return `vnasset://${hash}.${ext}`;
}

/**
 * The stored asset, decoded down to thumbnail size. Decoding at full resolution would put whole
 * 1024×1024 frames in the cache, which for a few hundred entries is most of a gigabyte of pixels;
 * `resizeWidth` does the downscale during the decode instead.
 *
 * A hash the store cannot answer for comes back as a 404 whose body is not an image, so the
 * response is checked before it reaches the decoder — otherwise the failure is reported as a
 * corrupt image rather than a missing one.
 */
export async function loadAssetThumb(hash: string, ext: string): Promise<ImageBitmap> {
  const url = assetThumbUrl(hash, ext);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`No stored bytes for ${hash.slice(0, 8)}.${ext} (${response.status}).`);
  }
  return createImageBitmap(await response.blob(), {
    resizeWidth: THUMB_WIDTH,
    resizeQuality: 'high',
  });
}

/**
 * One manifest row as the gallery takes it. The label is the one `labelAssets` resolved over the
 * whole manifest, so the picker calls a picture what the document tree calls it; the kind, the
 * slot it fills and its approval are what the search box matches beyond that name.
 */
export function galleryItem(asset: AssetListing): GalleryItem {
  const tags: string[] = [asset.kind];
  if (asset.slot) tags.push(asset.slot);
  if (asset.accepted) tags.push('accepted');

  return {
    id: asset.hash,
    label: asset.label,
    tooltip: `${asset.label} — ${asset.kind}${asset.accepted ? ' · accepted' : ''}`,
    searchTags: tags,
    image: () => loadAssetThumb(asset.hash, asset.ext),
  };
}
