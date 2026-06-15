/**
 * Zod schemas for every file shape and every machine-consumed LLM result (report §3,
 * §12). Validating at the boundary keeps malformed front-matter and malformed model
 * output from leaking into the deterministic core.
 */
import { z } from 'zod';

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected hex color');

/** Front-matter of `characters/<id>/character.md`. */
export const characterFrontMatter = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['draft', 'candidates', 'approved', 'locked']).default('draft'),
  default_outfit: z.string().default('default'),
  palette: z.array(hexColor).default([]),
  traits: z.array(z.string()).default([]),
  reference_images: z.array(z.string()).default([]),
  approved_portrait: z.string().optional(),
});
export type CharacterFrontMatter = z.infer<typeof characterFrontMatter>;

/** Front-matter of `locations/<id>.md` (user-authored). */
export const locationFrontMatter = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mood: z.string().optional(),
  lighting: z.string().optional(),
  palette: z.array(hexColor).default([]),
  variants: z.array(z.string()).default(['day']),
});
export type LocationFrontMatter = z.infer<typeof locationFrontMatter>;

const choiceSchema = z.object({ label: z.string(), goto: z.string() });

/** Front-matter of `scenes/<id>.md`. */
export const sceneFrontMatter = z.object({
  id: z.string().min(1),
  location: z.string().min(1),
  characters: z.array(z.string()).default([]),
  synopsis: z.string().optional(),
  choices: z.array(choiceSchema).default([]),
  next: z.string().optional(),
});
export type SceneFrontMatter = z.infer<typeof sceneFrontMatter>;

/** `project.yaml` (report §8, §11). */
export const projectConfig = z.object({
  title: z.string().min(1),
  art_style: z.string().default(''),
  models: z
    .object({
      image: z.string().default('gemini-2.5-flash-image'),
      vision: z.array(z.string()).default(['gemini-2.5-flash', 'claude-opus-4-8']),
      text: z.string().default('claude-opus-4-8'),
    })
    .default({}),
  image_params: z
    .object({
      aspect: z.string().default('16:9'),
      seed: z.number().optional(),
    })
    .default({}),
  /** Env var names that hold API keys; never the keys themselves. */
  keys: z
    .object({
      gemini: z.string().default('GEMINI_API_KEY'),
      anthropic: z.string().default('ANTHROPIC_API_KEY'),
    })
    .default({}),
  concurrency: z.number().int().positive().default(4),
  candidates: z.number().int().positive().default(3),
  max_refine_attempts: z.number().int().positive().default(4),
});
export type ProjectConfig = z.infer<typeof projectConfig>;

/** Structured critique returned by a vision reviewer (report §P7). */
export const defectReportSchema = z.object({
  reviewer: z.string(),
  defects: z
    .array(
      z.object({
        severity: z.enum(['blocking', 'major', 'minor']),
        category: z.string(),
        description: z.string(),
        suggestedFix: z.string().optional(),
      }),
    )
    .default([]),
});

/** Locations mined from the screenplay by the LLM (report §P1). */
export const minedLocationsSchema = z.object({
  locations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      aliases: z.array(z.string()).default([]),
      description: z.string(),
      variants: z.array(z.string()).default(['day']),
    }),
  ),
});

/** Shots proposed for one scene by the LLM (report §P5). */
export const shotDecompositionSchema = z.object({
  shots: z.array(
    z.object({
      id: z.string(),
      framing: z.enum(['wide', 'medium', 'close', 'establishing']),
      location: z.string(),
      subjects: z.array(
        z.object({
          characterId: z.string(),
          outfit: z.string().default('default'),
          pose: z.string().optional(),
          expression: z.string().optional(),
        }),
      ),
      camera: z.string().optional(),
      coversLines: z.array(z.string()).default([]),
    }),
  ),
});
