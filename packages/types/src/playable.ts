/**
 * The **playable** schema (`story.play.json`) — a flattened, ordered projection of the
 * project model that a runner can interpret directly (see docs/plans/archive/runner.md, Part B).
 *
 * It is a thin view over the existing `Scene`/`Shot`/`Asset` types: each scene becomes an
 * ordered list of `beats` (show a background, say a line, narrate) plus its branch edges.
 * Asset references are `{hash, ext}` (matching {@link AssetRef}) — resolved by the runner
 * (e.g. over a `vnasset://` protocol), never inlined. Missing assets are simply omitted so a
 * partially-generated project still plays.
 *
 * Validated at the boundary like every other machine-consumed shape (report §12).
 */
import { z } from 'zod';

/** A content-addressed asset reference, mirrors {@link AssetRef}. */
export const playableAssetRefSchema = z.object({
  hash: z.string().min(1),
  ext: z.string().min(1),
});

/** Show a background / shot image for the beats that follow. */
const showBeatSchema = z.object({
  type: z.literal('show'),
  /**
   * Which shot this frame is, so a runner can say where it is in the project — the one place
   * the playable names an authored id. Optional because a file written before the field still
   * parses; a runner that has none simply cannot jump.
   */
  shot: z.string().min(1).optional(),
  /** The shot image; omitted when the shot has no accepted asset yet (runner shows a placeholder). */
  image: playableAssetRefSchema.optional(),
});

/** A character speaks (dialogue or parenthetical). */
const sayBeatSchema = z.object({
  type: z.literal('say'),
  /** Speaking character id (a key into {@link Playable.characters}). */
  who: z.string().min(1),
  text: z.string(),
});

/** Un-attributed narration or action. */
const narrateBeatSchema = z.object({
  type: z.literal('narrate'),
  text: z.string(),
});

/** A single ordered beat within a scene. */
export const beatSchema = z.discriminatedUnion('type', [
  showBeatSchema,
  sayBeatSchema,
  narrateBeatSchema,
]);
export type Beat = z.infer<typeof beatSchema>;

/** A branch edge in the playable (mirrors {@link Choice}). */
export const playableChoiceSchema = z.object({
  label: z.string(),
  goto: z.string().min(1),
});

/** A character as the runner needs it: display name + optional portrait. */
export const playableCharacterSchema = z.object({
  name: z.string().min(1),
  portrait: playableAssetRefSchema.optional(),
});

/** One scene, flattened into ordered beats plus its outgoing edges. */
export const playableSceneSchema = z.object({
  beats: z.array(beatSchema).default([]),
  choices: z.array(playableChoiceSchema).default([]),
  /** Linear continuation, followed when `choices` is empty. */
  next: z.string().optional(),
});
export type PlayableScene = z.infer<typeof playableSceneSchema>;

/** The whole playable story. */
export const playableSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  /** Entry scene id. */
  start: z.string().optional(),
  /**
   * Draw the speaking character's portrait over the shot image. Defaulted rather than optional
   * so every consumer reads a plain boolean, and a file written before the field still parses.
   */
  portraitOverlay: z.boolean().default(false),
  characters: z.record(z.string(), playableCharacterSchema).default({}),
  scenes: z.record(z.string(), playableSceneSchema).default({}),
});
export type Playable = z.infer<typeof playableSchema>;
