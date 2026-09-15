import { Buffer } from 'node:buffer';
import type { AssetRef, ImageParams, ImageProvider, ImageResult } from '@vn/types';
import { ProviderError } from '@vn/util';
import type { ImageBackend, ImageInput, RefLoader } from './backend.js';
import { isPlaceholderImage } from './placeholder.js';

/** Leading magic bytes of the image formats the pipeline produces and consumes. */
const IMAGE_MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x52, 0x49, 0x46, 0x46], // RIFF (WebP)
];

/** Whether the bytes open with one of the magic numbers above. */
export function looksLikeImage(bytes: Uint8Array): boolean {
  return IMAGE_MAGIC.some((sig) => sig.every((b, i) => bytes[i] === b));
}

/**
 * Refuses a reference no image model should be sent, before any network round-trip. Every image
 * backend calls it, so a placeholder cannot reach a vendor through a backend that forgot to.
 *
 * A `--mock` asset decodes fine, so only its marker distinguishes it from generated art; reusing
 * one as a reference would condition a paid run on a coloured rectangle. Bytes that are not an
 * image at all are refused here because a vendor rejects them with an opaque 400.
 */
export function refGuard(img: ImageInput): void {
  if (isPlaceholderImage(img.bytes)) {
    throw new ProviderError(
      'reference image is a --mock placeholder, not generated art. ' +
        'Regenerate the references without --mock.',
    );
  }
  if (!looksLikeImage(img.bytes)) {
    const head = JSON.stringify(Buffer.from(img.bytes.slice(0, 8)).toString('latin1'));
    throw new ProviderError(
      `reference image is not a valid PNG/JPEG/WebP (starts with ${head}). ` +
        'Assets generated with --mock are placeholders — regenerate the references without --mock.',
    );
  }
}

/**
 * An `ImageProvider` over an `ImageBackend` (report §8). It resolves `AssetRef`
 * reference bundles to bytes before handing them to the backend, so the rest of the
 * pipeline deals only in content hashes.
 */
export class BackendImageProvider implements ImageProvider {
  constructor(
    private readonly backend: ImageBackend,
    private readonly loadRef: RefLoader,
  ) {}

  async generate(prompt: string, refs: AssetRef[], params: ImageParams): Promise<ImageResult> {
    const images = await Promise.all(refs.map((r) => this.loadRef(r)));
    return this.backend.generate(prompt, images, params);
  }

  async edit(
    base: AssetRef,
    prompt: string,
    refs: AssetRef[],
    params: ImageParams,
  ): Promise<ImageResult> {
    const [baseImage, ...images] = await Promise.all([base, ...refs].map((r) => this.loadRef(r)));
    return this.backend.edit(baseImage!, prompt, images, params);
  }
}
