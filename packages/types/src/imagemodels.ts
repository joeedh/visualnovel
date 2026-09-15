/**
 * The cached listing of image models OpenRouter routes to, and the two responses it is read from.
 * The listing lives in `<user>/models.json`, written by the desktop's `models.refresh` and read by
 * every image-model picker and by the graph estimate's OpenRouter price table.
 */
import { z } from 'zod';

/** A `YYYY-MM-DD` day, the same form a price table's `pricesAsOf` takes. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One image model as the listing keeps it. */
export const imageModelEntry = z.object({
  id      : z.string().min(1),
  name    : z.string(),
  /** The aspect ratios the model declares, in the listing's order. */
  aspects : z.array(z.string()),
  /** Whether the model takes a `seed`. */
  seed    : z.boolean(),
  /** Dollars per picture, where the model's endpoint bills per picture at a base tier. */
  priceUsd: z.number().nonnegative().optional(),
});

export type ImageModelEntry = z.infer<typeof imageModelEntry>;

/** The file: the day it was fetched and the OpenRouter models it listed. */
export const imageModelCatalog = z.object({
  asOf      : z.string().regex(DAY),
  openrouter: z.array(imageModelEntry),
});

export type ImageModelCatalog = z.infer<typeof imageModelCatalog>;

/**
 * `GET /api/v1/images/models`. `supported_parameters` is a map from parameter name to its shape,
 * of which only `aspect_ratio.values` and the presence of `seed` are read; the rest is passed
 * through unread.
 */
export const openRouterImageListing = z.object({
  data: z.array(
    z.object({
      id                  : z.string().min(1),
      name                : z.string().optional(),
      supported_parameters: z
        .record(z.object({ values: z.array(z.string()).optional() }).passthrough())
        .optional(),
    }),
  ),
});

export type OpenRouterImageListing = z.infer<typeof openRouterImageListing>;

/**
 * `GET /api/v1/images/models/{id}/endpoints`. A pricing row bills one thing (`output_image`,
 * `input_text`) in one unit (`image`, `token`, `megapixel`), and a `variant` names a tier above
 * the base one.
 */
export const openRouterImageEndpoints = z.object({
  endpoints: z.array(
    z.object({
      pricing: z
        .array(
          z.object({
            billable: z.string(),
            unit    : z.string(),
            cost_usd: z.number().nonnegative(),
            variant : z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export type OpenRouterImageEndpoints = z.infer<typeof openRouterImageEndpoints>;
