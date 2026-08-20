/**
 * Zod schemas for every file shape and every machine-consumed LLM result (report §3,
 * §12). Validating at the boundary keeps malformed front-matter and malformed model
 * output from leaking into the deterministic core.
 */
import { z } from 'zod';
import type { ChunkEdit, ChunkRef, PromptOverride } from './prompt.js';

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected hex color');

/**
 * The front-matter key that says what an authored document *is*, so an entity can be found by
 * content rather than by where it was filed. Named once here and imported everywhere: a string
 * literal at a call site is how the reader and the writer come to disagree about the key.
 */
export const ENTITY_TAG_KEY = 'type';

/** The document kinds the tag can name. A file in `characters/`/`locations/` carries its tag
 * implicitly from its location; stating a different one there is a conflict, not an override. */
export const ENTITY_TAGS = { character: 'character', location: 'location' } as const;
export type EntityTag = (typeof ENTITY_TAGS)[keyof typeof ENTITY_TAGS];

/**
 * One authored chunk edit. The bare-string form is what nearly every edit is; the object form
 * carries `of`, the derived text the edit was written against, so a later change underneath can be
 * carried forward rather than silently orphaning the author's words.
 */
const chunkEdit = z.union([
  z.string(),
  z.object({ text: z.string(), of: z.string().optional() }).strict(),
]);

/**
 * The slot a linked reference was resolved from. `.strict()` per member, so a misspelled address
 * is a parse error rather than a binding that silently resolves to nothing and reads as drift.
 */
const refBinding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('portrait'), characterId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('sheet'),
      characterId: z.string().min(1),
      outfit: z.string().min(1),
      angle: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('plate'),
      locationId: z.string().min(1),
      variant: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal('shot'), sceneId: z.string().min(1), shotId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal('asset'), hash: z.string().min(1) }).strict(),
]);

/** One reference image on one chunk. `from` absent is an upload: no slot, so it cannot drift. */
const chunkRef = z
  .object({
    pin: z.string().min(1),
    ext: z.string().min(1),
    from: refBinding.optional(),
    note: z.string().optional(),
  })
  .strict();

/**
 * An author's override of one derived image prompt (`docs/plans/chunked-prompts.md`). Stored at
 * the rung that names the whole picture, so "which override applies" is a lookup, never a merge.
 *
 * **No `.default()` anywhere in here.** A default would make `compact()` keep an empty
 * `prompt_override` key on every sheet's first edit, which is the failure the wardrobe's
 * `synthesized` check already exists to prevent. `.strict()` for the same reason `outfitEntry` is:
 * a misspelled key would silently drop an override from a prompt.
 */
export const promptOverrideSchema = z
  .object({
    mode: z.enum(['chunks', 'custom', 'agent']),
    mute: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
    replace: z.record(chunkEdit).optional(),
    append: z.record(chunkEdit).optional(),
    custom: z.string().optional(),
    agent: z
      .object({
        text: z.string(),
        of: z.string(),
        modelId: z.string().optional(),
        at: z.string().optional(),
      })
      .strict()
      .optional(),
    refs: z.record(z.array(chunkRef)).optional(),
  })
  .strict();
export type PromptOverrideFrontMatter = z.infer<typeof promptOverrideSchema>;

/**
 * The written form of a chunk edit → the in-memory one. Written once here because two readers
 * (`@vn/model`'s entity docs and `@vn/store`'s shots file) both parse an override, and a second
 * spelling of this mapping is how one of them comes to drop an author's `of`.
 */
function editsFrom(
  raw: Record<string, string | { text: string; of?: string }> | undefined,
): Record<string, ChunkEdit> | undefined {
  if (!raw) return undefined;
  const out: Record<string, ChunkEdit> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = typeof value === 'string' ? { text: value } : value;
  }
  return out;
}

/** Chunk keys whose reference list is empty carry no meaning, so they are never written. */
function refsOf(
  raw: Record<string, ChunkRef[]> | undefined,
): Record<string, ChunkRef[]> | undefined {
  if (!raw) return undefined;
  const kept = Object.entries(raw).filter(([, list]) => list.length > 0);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Drop the keys an override left unsaid, so a written one never grows an empty block. */
function said<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Parsed front matter → the in-memory {@link PromptOverride}. */
export function promptOverrideFrom(raw: PromptOverrideFrontMatter): PromptOverride {
  return said({
    mode: raw.mode,
    mute: raw.mute,
    order: raw.order,
    replace: editsFrom(raw.replace),
    append: editsFrom(raw.append),
    custom: raw.custom,
    agent: raw.agent,
    refs: refsOf(raw.refs),
  });
}

/**
 * The inverse. An edit that records no `of` is written back as the bare string it was read from,
 * which is what keeps a hand-authored `replace: { subject: '…' }` looking the way it was written.
 */
export function promptOverrideToDoc(o: PromptOverride): PromptOverrideFrontMatter {
  const edits = (
    map: Record<string, ChunkEdit> | undefined,
  ): Record<string, string | { text: string; of?: string }> | undefined => {
    if (!map || !Object.keys(map).length) return undefined;
    return Object.fromEntries(
      Object.entries(map).map(([key, e]) => [key, e.of === undefined ? e.text : e]),
    );
  };
  return said({
    mode: o.mode,
    mute: o.mute?.length ? o.mute : undefined,
    order: o.order?.length ? o.order : undefined,
    replace: edits(o.replace),
    append: edits(o.append),
    custom: o.custom,
    agent: o.agent,
    refs: refsOf(o.refs),
  });
}

/**
 * Whether an override would change nothing. `mode` alone is not an override — it names which of
 * the three shapes is in force, and all three fall back to the derived chunks when the shape they
 * name is empty. Writers use this to clear the key rather than grow an inert `prompt_override:` on
 * every sheet that was ever edited.
 */
export function promptOverrideIsEmpty(o: PromptOverride | undefined): boolean {
  if (!o) return true;
  const has = (map?: Record<string, ChunkEdit>): boolean => !!map && Object.keys(map).length > 0;
  return (
    !o.mute?.length &&
    !o.order?.length &&
    !has(o.replace) &&
    !has(o.append) &&
    !o.custom &&
    !o.agent &&
    refsOf(o.refs) === undefined
  );
}

/**
 * An authored image seed, at any rung that carries one. Non-negative and whole because that is
 * what an image backend takes; a fractional or negative seed is a typo, and coercing it would
 * quietly draw a different picture than the one written down.
 */
const imageSeed = z.number().int().nonnegative();

/**
 * The long form of a wardrobe entry or a location variant: what it is, plus how it should look.
 * `.strict()` because a misspelled key here would silently drop art direction from a prompt.
 */
const outfitEntry = z
  .object({
    description: z.string().default(''),
    art_notes: z.string().optional(),
    seed: imageSeed.optional(),
    prompt_override: promptOverrideSchema.optional(),
  })
  .strict();

const variantEntry = z
  .object({
    id: z.string().min(1),
    description: z.string().default(''),
    art_notes: z.string().optional(),
    seed: imageSeed.optional(),
    prompt_override: promptOverrideSchema.optional(),
  })
  .strict();

/** Front-matter of a character sheet — `characters/<id>/character.md`, or any `type: character`. */
export const characterFrontMatter = z.object({
  id: z.string().min(1),
  /** Optional in the conventional directory, which carries the tag implicitly. */
  type: z.literal(ENTITY_TAGS.character).optional(),
  name: z.string().min(1),
  status: z.enum(['draft', 'candidates', 'approved', 'locked']).default('draft'),
  default_outfit: z.string().default('default'),
  /**
   * The character's wardrobe, outfit id → description, in the order written. The description is
   * what a prompt says the character is wearing; an id with no entry falls back to saying the id.
   * `default_outfit` need not appear — it is synthesized when the map omits it.
   *
   * An outfit that carries art direction of its own is written as an object instead; the string
   * form is kept because it is what nearly every wardrobe needs and what every sheet already has.
   */
  outfits: z.record(z.union([z.string(), outfitEntry])).default({}),
  palette: z.array(hexColor).default([]),
  traits: z.array(z.string()).default([]),
  /** Free-form art direction appended to every prompt this character reaches. */
  art_notes: z.string().optional(),
  /** Image seed for every prompt this character reaches; an outfit entry's own seed is narrower. */
  seed: imageSeed.optional(),
  /** Overrides the derived *portrait* prompt. A sheet's override lives on its outfit entry. */
  prompt_override: promptOverrideSchema.optional(),
  approved_portrait: z.string().optional(),
});
export type CharacterFrontMatter = z.infer<typeof characterFrontMatter>;

/** Front-matter of a set-location sheet — `locations/<id>.md`, or any `type: location`. */
export const locationFrontMatter = z.object({
  id: z.string().min(1),
  /** Optional in the conventional directory, which carries the tag implicitly. */
  type: z.literal(ENTITY_TAGS.location).optional(),
  name: z.string().min(1),
  mood: z.string().optional(),
  lighting: z.string().optional(),
  palette: z.array(hexColor).default([]),
  /**
   * The variants plates are generated for, in the order written. A bare string is the id alone;
   * a variant that describes itself or carries art direction is written as an object.
   */
  variants: z.array(z.union([z.string(), variantEntry])).default(['day']),
  /** Free-form art direction appended to every plate of this location. */
  art_notes: z.string().optional(),
  /** Image seed for every plate of this location; a variant entry's own seed is narrower. */
  seed: imageSeed.optional(),
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
  /**
   * Draw the speaking character's portrait over the shot image in a runner. Off by default
   * because a shot prompt names its own subjects, so the frame already contains them and an
   * overlay is the same character twice. Turning it on stages the classic
   * background-plus-sprite look — but against a P3 portrait, which is an opaque plate and not
   * a keyed cutout (docs/plans/portrait-overlay-opt-in.md).
   */
  portrait_overlay: z.boolean().default(false),
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
  /** Absent means inherit — see {@link ShotSubject.outfit}. Never defaulted, or it would not. */
  outfit: z.string().optional(),
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
 * One prompt condensed from a chunk list by the LLM (`docs/plans/chunked-prompts.md` §4).
 *
 * `omitted` is what the model *says* it could not fit. It is advisory and nothing rejects a
 * condensation over it — the authoritative answer is the local coverage check run over `prompt`.
 */
export const condensedPromptSchema = z.object({
  prompt: z.string().min(1),
  omitted: z.array(z.string()).default([]),
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
  /**
   * High-water mark for hand-allocated `<sceneId>__shot<n>` ids — the `Scene.nextLineId`
   * posture. A shot's id is in its task hash, so re-minting a retired id would resolve to an
   * already-done task and silently inherit the deleted shot's frame; the mark only ever rises.
   * Absent on decomposed and pre-mark files, where it is derived by scanning existing ids.
   */
  nextShot: z.number().int().positive().optional(),
  shots: z
    .array(
      z.object({
        id: z.string().min(1),
        sceneId: z.string().min(1),
        framing: shotFraming,
        location: z.string().min(1),
        subjects: z.array(shotSubject).default([]),
        camera: z.string().optional(),
        /** Authored art direction for this frame; in the prompt, so editing it re-renders it. */
        artNotes: z.string().optional(),
        /** Authored image seed for this frame; in the task hash, so editing it re-renders it. */
        seed: imageSeed.optional(),
        /**
         * The author's override of this frame's derived prompt. Authored, so it sits at top level
         * beside `artNotes` and **never** inside `shotData`, which a run rewrites wholesale.
         */
        promptOverride: promptOverrideSchema.optional(),
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
