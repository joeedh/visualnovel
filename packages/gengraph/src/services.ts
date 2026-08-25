import type { AssetRef, ImageParams, ImageResult } from '@vn/types';

/** A blob written by a node run, addressed by content hash. */
export interface GenBlobRef {
  hash: string;
  ext: string;
}

/** The subset of a request a node may make through the host's ring-recorded transport. */
export interface GenFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface GenFetchResult {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

/** Text completion, with the model id threaded through because a node authors its own. */
export interface GenTextService {
  complete(modelId: string, prompt: string, system?: string): Promise<string>;
  structured<T>(
    modelId: string,
    prompt: string,
    parse: (raw: string) => T,
    system?: string,
  ): Promise<T>;
}

/** A reference picture as the model receives it, with the extension its mime type is read from. */
export interface GenImageInput {
  bytes: Uint8Array;
  ext: string;
}

/**
 * The two image calls, taking reference pictures as bytes rather than as an
 * {@link AssetRef}, because a node's references come from the blob store its upstream
 * wrote to. The host adapter reads them out of whichever store holds them.
 */
export interface GenImageService {
  generate(prompt: string, refs: GenImageInput[], params: ImageParams): Promise<ImageResult>;
  edit(
    base: GenImageInput,
    prompt: string,
    refs: GenImageInput[],
    params: ImageParams,
  ): Promise<ImageResult>;
}

export interface GenBlobService {
  read(hash: string): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array, ext: string): Promise<GenBlobRef>;
}

export interface GenAssetService {
  read(ref: AssetRef): Promise<Uint8Array | undefined>;
  /** The asset a slot currently holds, or undefined while the slot is empty. */
  slot(slotKey: string): Promise<AssetRef | undefined>;
}

/**
 * Everything a node runtime may reach outside its own inputs and props. The host
 * supplies it, so the same node type runs against real providers in the app and
 * against mocks in a test. The derived prompt is deliberately absent: the host seeds
 * it as an input value rather than exposing a way to re-derive it mid-run.
 */
export interface GenServices {
  image: GenImageService;
  text: GenTextService;
  blobs: GenBlobService;
  assets: GenAssetService;
  /** Recorded in the request ring, so a fault can be read against the body that caused it. */
  fetch(url: string, init?: GenFetchInit): Promise<GenFetchResult>;
  /** The value of the named key, or undefined when no source supplies one. */
  key(name: string): Promise<string | undefined>;
}
