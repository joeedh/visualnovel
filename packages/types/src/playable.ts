/**
 * The playable schema (`story.play.json`) — a flattened, ordered projection of the
 * project model that a runner can interpret directly (see docs/plans/archive/INDEX.md#runner, Part B).
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
  ext : z.string().min(1),
});

/** A point on the page, in page fractions. */
const pagePoint = z.tuple([z.number(), z.number()]);

/**
 * A speech bubble the runner draws for one of a panel's lines: where it sits and, when it has
 * one, where its tail points. Present only when the project letters its pages in the runner; a
 * runner that ignores the field reads the line in its dialogue box.
 */
export const playableBubbleSchema = z.object({
  line  : z.string().min(1),
  anchor: pagePoint,
  tail  : pagePoint.optional(),
  /** Whether the speaker's name is shown, in place of {@link Playable.bubbleNames}. */
  name  : z.boolean().optional(),
});
export type PlayableBubble = z.infer<typeof playableBubbleSchema>;

/**
 * One panel of a page shot, as the runner needs it: its outline in page fractions and the ids of
 * the lines it letters, so a runner can light the panel whose line is being read.
 */
export const playablePanelSchema = z.object({
  shape  : z.array(pagePoint).min(3),
  lines  : z.array(z.string().min(1)),
  bubbles: z.array(playableBubbleSchema).optional(),
});
export type PlayablePanel = z.infer<typeof playablePanelSchema>;

/** Show a background / shot image for the beats that follow. */
const showBeatSchema = z.object({
  type  : z.literal('show'),
  /**
   * Which shot this frame is, so a runner can say where the frame sits in the project. This is
   * the one place the playable names an authored id. Optional so that a file written before the
   * field still parses; a runner reading a beat without this id cannot jump to the shot.
   */
  shot  : z.string().min(1).optional(),
  /** The shot image; omitted when the shot has no accepted asset yet (runner shows a placeholder). */
  image : playableAssetRefSchema.optional(),
  /**
   * The panels of a page shot, in reading order. Absent on a single frame. A runner that ignores
   * the field shows the page whole, which is what every runner did before the field existed.
   */
  panels: z.array(playablePanelSchema).optional(),
});

/**
 * The id of the screenplay line a beat was made from, so a runner can find the panel that
 * letters it. Optional so that a file written before the field still parses.
 */
const lineId = z.string().min(1).optional();

/** A character speaks (dialogue or parenthetical). */
const sayBeatSchema = z.object({
  type: z.literal('say'),
  /** Speaking character id (a key into {@link Playable.characters}). */
  who : z.string().min(1),
  text: z.string(),
  line: lineId,
});

/** Un-attributed narration or action. */
const narrateBeatSchema = z.object({
  type: z.literal('narrate'),
  text: z.string(),
  line: lineId,
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
  goto : z.string().min(1),
});

/** A character as the runner needs it: display name + optional portrait. */
export const playableCharacterSchema = z.object({
  name    : z.string().min(1),
  portrait: playableAssetRefSchema.optional(),
});

/** One scene, flattened into ordered beats plus its outgoing edges. */
export const playableSceneSchema = z.object({
  beats  : z.array(beatSchema).default([]),
  choices: z.array(playableChoiceSchema).default([]),
  /** Linear continuation, followed when `choices` is empty. */
  next   : z.string().optional(),
});
export type PlayableScene = z.infer<typeof playableSceneSchema>;

/** The whole playable story. */
export const playableSchema = z.object({
  version        : z.literal(1),
  title          : z.string(),
  /** Entry scene id. */
  start          : z.string().optional(),
  /**
   * Draw the speaking character's portrait over the shot image. Defaulted rather than optional
   * so every consumer reads a plain boolean, and a file written before the field still parses.
   */
  portraitOverlay: z.boolean().default(false),
  /**
   * Show the speaker's name above the line in a bubble drawn for a `say` beat; a `narrate`
   * beat's caption never carries one. A bubble's own `name` overrides it. Defaulted like
   * `portraitOverlay`, so a file written before the field still parses.
   */
  bubbleNames    : z.boolean().default(false),
  characters     : z.record(z.string(), playableCharacterSchema).default({}),
  scenes         : z.record(z.string(), playableSceneSchema).default({}),
});
export type Playable = z.infer<typeof playableSchema>;
