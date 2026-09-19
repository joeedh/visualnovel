/**
 * What the two OpenRouter backends share: the error class, the data-URL reference, and one POST
 * that turns a status code into the right error class ahead of the retry policy.
 */
import { Buffer } from 'node:buffer';
import { ProviderError, RetryableProviderError } from '@vn/util';
import type { ImageInput } from '../backend.js';
import { refGuard } from '../image.js';
import { imageMime } from './mime.js';
import { retryAfterMs, retryableStatus } from './transient.js';

/** How much of a refused response is quoted back, so an error stays readable. */
export const ERROR_CHARS = 400;

/** The transport, injectable so a test can stand a fake endpoint up. */
export type FetchImpl = typeof fetch;

/**
 * A refusal that carries its HTTP status, so `isTransient` reads the number and `faultKind` reads
 * the code at the head of the message.
 */
export class OpenRouterError extends ProviderError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** An image part as a request carries it: a data URL, which OpenRouter takes in place of a hosted one. */
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

/** One reference as the request carries it. */
export function reference(img: ImageInput): ImagePart {
  refGuard(img);
  const mime = imageMime(img);
  const data = Buffer.from(img.bytes).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
}

/**
 * One request, answered as parsed JSON. A 429 or a 5xx becomes a `RetryableProviderError`
 * carrying the `retry-after` the response sent; any other non-200 is an {@link OpenRouterError};
 * a body that is not JSON is a `ProviderError`. The key rides in the header and never in an error.
 */
export async function postOpenRouter(
  fetchImpl: FetchImpl,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body   : JSON.stringify(body),
  });
  const said = await response.text();

  if (response.status !== 200) {
    const message = `${response.status} OpenRouter: ${said.slice(0, ERROR_CHARS)}`;
    if (retryableStatus(response.status)) {
      const after = retryAfterMs({ headers: response.headers });
      throw new RetryableProviderError(message, {
        ...(after === undefined ? {} : { retryAfterMs: after }),
      });
    }
    throw new OpenRouterError(response.status, message);
  }

  try {
    return JSON.parse(said);
  } catch {
    throw new ProviderError(
      `OpenRouter answered with something that is not JSON: ${said.slice(0, ERROR_CHARS)}`,
    );
  }
}
