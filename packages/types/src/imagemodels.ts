/**
 * The cached model listing and the responses it is read from: the image models OpenRouter routes
 * to, and the text models each vendor listed when a key for it resolved. The listing lives in
 * `<user>/models.json`, written by the desktop's `models.refresh` and read by every model picker
 * and by the graph estimate's OpenRouter price table.
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

/** The transports a listed text model is reached through. */
export const TEXT_MODEL_VENDORS = ['anthropic', 'gemini', 'openrouter'] as const;

/** One text model as the listing keeps it: the id a call names, and who listed it. */
export const textModelEntry = z.object({
  id    : z.string().min(1),
  name  : z.string(),
  vendor: z.enum(TEXT_MODEL_VENDORS),
});

export type TextModelEntry = z.infer<typeof textModelEntry>;

/**
 * The file: the day it was fetched, the OpenRouter image models it listed, and the text models
 * each vendor listed. `text` defaults to none so a file written before it existed still reads.
 */
export const imageModelCatalog = z.object({
  asOf      : z.string().regex(DAY),
  openrouter: z.array(imageModelEntry),
  text      : z.array(textModelEntry).default([]),
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

/**
 * `GET https://api.anthropic.com/v1/models`. Only the id and the display name are read; the
 * listing is paged, and `has_more` says whether a page follows.
 */
export const anthropicModelListing = z.object({
  data: z.array(
    z.object({
      id          : z.string().min(1),
      display_name: z.string().optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id : z.string().nullable().optional(),
});

export type AnthropicModelListing = z.infer<typeof anthropicModelListing>;

/**
 * `GET https://generativelanguage.googleapis.com/v1beta/models`. A model is named in the long form
 * `models/<id>`, and `supportedGenerationMethods` says whether it answers `generateContent`.
 */
export const geminiModelListing = z.object({
  models: z.array(
    z.object({
      name                      : z.string().min(1),
      displayName               : z.string().optional(),
      supportedGenerationMethods: z.array(z.string()).optional(),
    }),
  ),
  nextPageToken: z.string().optional(),
});

export type GeminiModelListing = z.infer<typeof geminiModelListing>;

/**
 * `GET https://openrouter.ai/api/v1/models`. `architecture` says what a model takes and answers
 * with, which is what separates a chat model from an image or an embedding one.
 */
export const openRouterModelListing = z.object({
  data: z.array(
    z.object({
      id          : z.string().min(1),
      name        : z.string().optional(),
      architecture: z
        .object({
          input_modalities : z.array(z.string()).optional(),
          output_modalities: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional(),
    }),
  ),
});

export type OpenRouterModelListing = z.infer<typeof openRouterModelListing>;
