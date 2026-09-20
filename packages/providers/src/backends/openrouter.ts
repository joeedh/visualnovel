/**
 * OpenRouter's image endpoint as an `ImageBackend`. A model id here is `<vendor>/<model>`, and
 * OpenRouter routes the call to that vendor; the endpoint has no edit form, so an edit is a
 * generate with the base picture placed ahead of the references, as the Gemini backend does it.
 */
import { Buffer } from 'node:buffer';
import type { ImageParams, ImageResult } from '@vn/types';
import { ProviderError } from '@vn/util';
import type { ImageBackend, ImageInput } from '../backend.js';
import { captureRequest } from './capture.js';
import { postOpenRouter, reference, type FetchImpl } from './openrouter-common.js';
import { callWithRetry } from './transient.js';

export const OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images';

export interface OpenRouterImageOptions {
  fetchImpl?: FetchImpl;
  /**
   * Whether the model takes a `seed`, as the catalog lists it. `false` refuses a call carrying
   * one by name, ahead of the request; absent, the seed is sent as given.
   */
  seed?: boolean;
  /**
   * The aspect ratios the model accepts, as the catalog lists them. A call whose ratio is not
   * among them is sent with the nearest listed one instead of failing with a 400; absent or
   * empty, the ratio is sent as given.
   */
  aspects?: readonly string[];
}

/** A `w:h` ratio as a number, or `undefined` for a word such as `auto`. */
function ratioOf(aspect: string): number | undefined {
  const m = /^(\d+):(\d+)$/.exec(aspect.trim());
  if (!m) return undefined;
  const h = Number(m[2]);
  return h === 0 ? undefined : Number(m[1]) / h;
}

/**
 * The listed ratio to send for a requested one. Returns the request itself when it is listed or
 * when the list is empty; otherwise the listed `w:h` ratio nearest to it in log space, so 16:9
 * snaps to 3:2 and 9:16 to 2:3 rather than both to 1:1. A list holding only words (`auto`) sends
 * the request as given.
 */
export function snapAspect(aspect: string, accepted: readonly string[]): string {
  if (accepted.length === 0 || accepted.includes(aspect)) return aspect;
  const wanted = ratioOf(aspect);
  if (wanted === undefined) return aspect;
  let best: string | undefined;
  let bestGap = Infinity;
  for (const candidate of accepted) {
    const ratio = ratioOf(candidate);
    if (ratio === undefined) continue;
    const gap = Math.abs(Math.log(ratio) - Math.log(wanted));
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  return best ?? aspect;
}

/** The first picture in a reply, or nothing where the reply carries none. */
function firstImage(reply: unknown, modelId: string): ImageResult | undefined {
  const data = (reply as { data?: unknown[] } | null)?.data;
  for (const item of data ?? []) {
    const entry = item as { b64_json?: unknown; media_type?: unknown };
    if (typeof entry.b64_json !== 'string') continue;
    const mime = typeof entry.media_type === 'string' ? entry.media_type : 'image/png';
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    return { bytes: new Uint8Array(Buffer.from(entry.b64_json, 'base64')), ext, modelId };
  }
  return undefined;
}

/**
 * OpenRouter image backend. Every call sends `data_collection: deny`, which keeps the prompt and
 * the picture out of any provider that trains on or logs its traffic; `aspect_ratio` and `seed`
 * go only when set. The refusal quotes OpenRouter's own answer, which is where a provider's
 * reason for refusing a ratio or a reference arrives, and the key is never part of it.
 */
export function createOpenRouterImage(
  apiKey: string,
  modelId: string,
  opts: OpenRouterImageOptions = {},
): ImageBackend {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const run = async (
    images: ImageInput[],
    prompt: string,
    params: ImageParams,
  ): Promise<ImageResult> => {
    if (opts.seed === false && params.seed !== undefined) {
      throw new ProviderError(
        `${modelId} takes no seed, and this call carries seed ${params.seed}; clear it to draw`,
      );
    }
    const refs = images.map(reference);
    const aspect =
      params.aspect === undefined ? undefined : snapAspect(params.aspect, opts.aspects ?? []);
    const body = {
      model: modelId,
      prompt,
      ...(aspect === undefined ? {} : { aspect_ratio: aspect }),
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      ...(refs.length === 0 ? {} : { input_references: refs }),
      provider: { data_collection: 'deny' },
    };
    // The ring keeps the body without its pictures: a 400 names a field rather than a byte of
    // a reference, and one page's base64 would evict a conversation
    const refBytes = refs.reduce((n, ref) => n + ref.image_url.url.length, 0);
    const capture = await captureRequest('openrouter-image', {
      ...body,
      ...(refs.length === 0
        ? {}
        : { input_references: `${refs.length} references, ${refBytes} bytes` }),
    });

    try {
      return await callWithRetry(`OpenRouter image request failed (${modelId})`, async () => {
        const parsed = await postOpenRouter(fetchImpl, OPENROUTER_IMAGES_URL, apiKey, body);
        const picture = firstImage(parsed, modelId);
        if (picture === undefined) {
          throw new ProviderError(`OpenRouter returned no picture (${modelId})`);
        }
        return picture;
      });
    } catch (err) {
      await capture.failed(err);
      throw err;
    }
  };

  return {
    modelId,
    generate: (prompt, refs, params) => run(refs, prompt, params),
    edit    : (base, prompt, refs, params) => run([base, ...refs], prompt, params),
  };
}
