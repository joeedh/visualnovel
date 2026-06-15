import type { AssetRef, ImageParams, ImageProvider, ImageResult } from '@vn/types';
import type { ImageBackend, RefLoader } from './backend.js';

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
