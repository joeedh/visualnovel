/**
 * OpenRouter's image-model listing, read into the catalog the pickers draw. Neither endpoint needs
 * a key and neither bills anything.
 */
import {
  imageModelEntry,
  openRouterImageEndpoints,
  openRouterImageListing,
  type ImageModelEntry,
} from '@vn/types';
import { ProviderError } from '@vn/util';
import type { FetchImpl } from './openrouter.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/images/models';

/** How much of a refused response is quoted back, so an error stays readable. */
const ERROR_CHARS = 400;

export interface OpenRouterListing {
  models: ImageModelEntry[];
  /** The ids whose endpoints call failed, which are listed without a price. */
  unpriced: string[];
}

async function readJson(fetchImpl: FetchImpl, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  const said = await response.text();
  if (response.status !== 200) {
    throw new ProviderError(`${response.status} OpenRouter: ${said.slice(0, ERROR_CHARS)}`);
  }
  try {
    return JSON.parse(said);
  } catch {
    throw new ProviderError(
      `OpenRouter answered with something that is not JSON: ${said.slice(0, ERROR_CHARS)}`,
    );
  }
}

/**
 * The per-picture price a model's endpoints state, or nothing. Only a row billing `output_image`
 * by the `image` is a price per picture; a model billed per token or per megapixel has none until
 * it has drawn. The base tier is the row without a `variant`, and the cheapest row stands in
 * where every row names one.
 */
export function perImagePrice(endpoints: unknown): number | undefined {
  const parsed = openRouterImageEndpoints.safeParse(endpoints);
  if (!parsed.success) return undefined;
  const rows = parsed.data.endpoints
    .flatMap((endpoint) => endpoint.pricing ?? [])
    .filter((row) => row.billable === 'output_image' && row.unit === 'image');
  if (rows.length === 0) return undefined;
  const base = rows.find((row) => row.variant === undefined);
  return base?.cost_usd ?? Math.min(...rows.map((row) => row.cost_usd));
}

/**
 * Reads the listing, then each model's endpoints for its price. The listing is the part that has
 * to succeed: a failure there is thrown, and nothing is written from it. A model whose endpoints
 * call fails is returned without a price and named in `unpriced`, so one bad endpoint does not
 * lose the list.
 */
export async function listOpenRouterImageModels(
  fetchImpl: FetchImpl = fetch,
): Promise<OpenRouterListing> {
  const listing = openRouterImageListing.safeParse(
    await readJson(fetchImpl, OPENROUTER_MODELS_URL),
  );
  if (!listing.success) {
    throw new ProviderError(`OpenRouter's model listing did not read: ${listing.error.message}`);
  }

  const models: ImageModelEntry[] = [];
  const unpriced: string[] = [];
  for (const model of listing.data.data) {
    const params = model.supported_parameters ?? {};
    let priceUsd: number | undefined;
    try {
      priceUsd = perImagePrice(
        await readJson(fetchImpl, `${OPENROUTER_MODELS_URL}/${model.id}/endpoints`),
      );
    } catch {
      unpriced.push(model.id);
    }
    models.push(
      imageModelEntry.parse({
        id     : model.id,
        name   : model.name ?? model.id,
        aspects: params['aspect_ratio']?.values ?? [],
        seed   : 'seed' in params,
        ...(priceUsd === undefined ? {} : { priceUsd }),
      }),
    );
  }
  return { models, unpriced };
}
