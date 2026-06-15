import type { AssetRef, ImageParams, ImageResult } from '@vn/types';

/** An image attached to a chat/vision request. */
export interface ImageInput {
  bytes: Uint8Array;
  ext: string;
}

/** A single chat/vision turn (text + optional images) → text response. */
export interface ChatRequest {
  system?: string;
  prompt: string;
  images?: ImageInput[];
}

/**
 * The low-level seam every text/vision provider sits on. Concrete backends wrap a
 * vendor SDK (Anthropic, Gemini); tests inject a fake/recorded backend so the
 * structured-output and reviewer contracts can be exercised without network access.
 */
export interface ChatBackend {
  readonly modelId: string;
  message(req: ChatRequest): Promise<string>;
}

/** The low-level seam for image generation/editing. */
export interface ImageBackend {
  readonly modelId: string;
  generate(prompt: string, refs: ImageInput[], params: ImageParams): Promise<ImageResult>;
  edit(
    base: ImageInput,
    prompt: string,
    refs: ImageInput[],
    params: ImageParams,
  ): Promise<ImageResult>;
}

/** Resolves an AssetRef to bytes; lets providers turn refs into image inputs. */
export type RefLoader = (ref: AssetRef) => Promise<ImageInput>;
