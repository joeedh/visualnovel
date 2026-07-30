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

/**
 * Front-matter of `scenes/<id>.md` — the scene's identity and nothing else. Every other
 * field (heading, location, synopsis, choices, next, line ids) lives in the Fountain body,
 * where `splitScenes` reads it and `sceneToFountain` writes it back losslessly; a
 * front-matter copy would be a second source of truth for a field that already has one.
 * Hence `.strict()`: an unrecognized key is an error, not a silently ignored line.
 */
export const sceneFrontMatter = z
  .object({
    /** Must equal the filename stem; `@vn/model` reports a mismatch rather than picking one. */
    scene: z.string().min(1),
  })
  .strict();
export type SceneFrontMatter = z.infer<typeof sceneFrontMatter>;

/** `project.yaml` (report §8, §11). */
export const projectConfig = z.object({
  title: z.string().min(1),
  art_style: z.string().default(''),
  /**
   * The entry scene's id. Optional here rather than required because a project without it is an
   * error diagnostic from the model, which can name the scene ids on offer as this schema cannot
   * — and because a not-yet-imported project has no scene ids to name one of.
   */
  start: z.string().min(1).optional(),
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
  /**
   * Total run-level attempts at a task before the scheduler stops requeueing it, so the
   * default of 2 is one retry. Orthogonal to `max_refine_attempts`, which caps P7's
   * critique→refine loop *within* a single run of one shot task.
   */
  max_task_attempts: z.number().int().positive().default(2),
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

const shotFraming = z.enum(['wide', 'medium', 'close', 'establishing']);

const shotSubject = z.object({
  characterId: z.string(),
  outfit: z.string().default('default'),
  pose: z.string().optional(),
  expression: z.string().optional(),
});

/** Shots proposed for one scene by the LLM (report §P5). */
export const shotDecompositionSchema = z.object({
  shots: z.array(
    z.object({
      id: z.string(),
      framing: shotFraming,
      location: z.string(),
      subjects: z.array(shotSubject),
      camera: z.string().optional(),
      coversLines: z.array(z.string()).default([]),
    }),
  ),
});

/**
 * The derived half of a persisted shot: what a run produced, never what a human authored.
 * Rewritten wholesale on every run from the task graph and the manifest, which remain the
 * authority — this is a readable copy, not an input. Absent means "not run yet".
 */
export const shotDataSchema = z.object({
  /** P6, rebuilt by `buildShotPrompt` from the authored fields. */
  prompt: z.string().optional(),
  /** P7 output asset hash; `manifest.json` is the authority for the bytes. */
  image: z.string().optional(),
  /**
   * Hash of the covered lines' text when `image` was produced, so a later load can tell that the
   * frame no longer illustrates what the scene says. Recorded with the bytes and never refreshed
   * without them — a rerun that reports the same image must not clear a drift the author has not
   * acted on. Absent means unknown, which is what every shot rendered before this field reads as.
   */
  proseHash: z.string().optional(),
  status: z.enum(['pending', 'prompted', 'generated', 'accepted', 'needs_human']),
});

/**
 * `work/shots/<sceneId>.json` — one scene's decomposition, persisted so a run reuses it
 * instead of re-decomposing (the LLM path is non-deterministic, and re-decomposing would
 * change shot ids, hence task identities, hence regenerate art for no reason).
 *
 * Everything outside `shotData` is authored and is what a later run compares against.
 */
export const shotsFileSchema = z.object({
  version: z.literal(1),
  scene: z.string().min(1),
  shots: z
    .array(
      z.object({
        id: z.string().min(1),
        sceneId: z.string().min(1),
        framing: shotFraming,
        location: z.string().min(1),
        subjects: z.array(shotSubject).default([]),
        camera: z.string().optional(),
        coversLines: z.array(z.string()).default([]),
        shotData: shotDataSchema.optional(),
      }),
    )
    .default([]),
});
export type ShotsFile = z.infer<typeof shotsFileSchema>;

/**
 * One recorded image-model response in the fixture asset cache. Provenance in the same
 * spirit as `manifest.json`: enough to see what was asked for, of which model, and when —
 * so a stale or orphaned entry can be recognized without replaying the request.
 */
export const assetCacheEntrySchema = z.object({
  /** `requestKey`: sha256 over the operation, prompt, ordered ref-byte hashes, and params. */
  key: z.string().min(1),
  op: z.enum(['generate', 'edit']),
  ext: z.string().min(1),
  /** The model that actually produced these bytes. `params.modelId` is part of `key`. */
  modelId: z.string().min(1),
  prompt: z.string(),
  /** sha256 of each reference image's bytes, in the order they were sent. */
  refs: z.array(z.string()).default([]),
  params: z.record(z.unknown()).default({}),
  bytes: z.number().int().nonnegative(),
  /** ISO date of the recording. */
  recordedAt: z.string(),
  /** The fixture whose run produced it, when the recorder knows. */
  fixture: z.string().optional(),
});
export type AssetCacheEntry = z.infer<typeof assetCacheEntrySchema>;

/** `index.json` of a fixture asset cache; the bytes live beside it as `<key>.<ext>`. */
export const assetCacheIndexSchema = z.object({
  version: z.literal(1),
  entries: z.array(assetCacheEntrySchema).default([]),
});
export type AssetCacheIndex = z.infer<typeof assetCacheIndexSchema>;
