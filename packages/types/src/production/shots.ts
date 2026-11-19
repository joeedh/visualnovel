/** Shots, the pictures a scene is drawn as, with a page shot's panels and bubbles. */
import type { PromptOverride } from '../prompt.js';

/**
 * Whether a shot's rendered frame still illustrates the words it covers. Derived on every read
 * by `@vn/stills`' `driftOf` and never persisted — a stored flag can be stale, a hash cannot.
 * The shape lives here because the timeline, the task list and the inspector all name it.
 */
export type Drift =
  /** No image yet, so there is nothing that could be stale. */
  | 'unrendered'
  /** The recorded prose hash matches: this frame was made from these words. */
  | 'current'
  /** The recorded prose hash does not match. The frame stands until something asks for a redraw. */
  | 'drifted'
  /** Rendered before {@link Shot.proseHash} existed, so drift cannot be determined. */
  | 'unknown';

/** A rectangle in page fractions, `x`/`y` its top-left corner. */
export interface PanelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A speech bubble the runner draws over a page under `lettering: runner`. Authored on the panel
 * that letters the line, in page fractions; not in the prompt, so placing one re-renders nothing.
 */
export interface PanelBubble {
  /** One of the parent panel's {@link PagePanel.coversLines}; a line has at most one bubble. */
  lineId: string;
  /** Where the bubble sits. */
  anchor: [number, number];
  /** Where the tail points, at the speaker. Absent draws a caption box with no tail. */
  tail?: [number, number];
  /**
   * Whether the speaker's name is shown above the line, in place of the project's
   * `bubble_names`. Absent inherits it. Read only for a dialogue line; narration has no name.
   */
  name?: boolean;
}

/**
 * One panel of a page shot. A shot with panels renders one picture, the whole page, and each
 * panel is a region of it with its own framing, camera and cast; outfits come from the parent
 * shot's cast, so a character wears one outfit across the page.
 */
export interface PagePanel {
  /** The panel's outline in page fractions, clockwise, at least three points. */
  shape: [number, number][];
  framing: Shot['framing'];
  camera?: string;
  /**
   * Who is in this panel, with the pose and expression they hold there. Each must be in the
   * parent shot's {@link Shot.subjects}; the store refuses a panel naming anyone else.
   */
  subjects: { characterId: string; pose?: string; expression?: string }[];
  /** A partition of the parent shot's {@link Shot.coversLines}: the lines lettered here. */
  coversLines: string[];
  /** Art direction for this panel alone, appended to the panel's own sentence. */
  artNotes?: string;
  /** The bubbles the runner draws for this panel's lines. Absent or empty means none is placed. */
  bubbles?: PanelBubble[];
}

/** A single rendered image within a scene (report §3, §P5). */
export interface Shot {
  id: string;
  /** Parent scene id. */
  sceneId: string;
  framing: 'wide' | 'medium' | 'close' | 'establishing';
  /** Location variant id this shot is set in. */
  location: string;
  subjects: ShotSubject[];
  /**
   * Whether {@link subjects} are carried as references rather than as a casting instruction. The
   * reviewer is then told nothing has to be in frame, so a subject the image leaves out is no
   * longer a blocking defect and the refine loop stops burning attempts on it. Absent means the
   * subjects must appear, which is what every shot a decomposer wrote means.
   */
  castOptional?: boolean;
  camera?: string;
  /** Art direction for this frame alone — see `Character.artNotes`. Authored, like
   * {@link camera}, and in the prompt, so editing it re-renders this shot and nothing else. */
  artNotes?: string;
  /** Image seed for this frame alone — see `Character.seed`. Authored, like {@link artNotes}. */
  seed?: number;
  /** Image model for this frame alone — see `Character.imageModel`. */
  imageModel?: string;
  /**
   * Aspect ratio for this frame alone, such as `3:4`, in place of `image_params.aspect`. Authored,
   * like {@link seed}, and in the task's params, so setting it re-renders this shot and nothing
   * else.
   */
  aspect?: string;
  /**
   * The panels of a page shot. Absent means a single frame, which is what every shot was before
   * pages existed. Authored, and in the prompt: the page's layout, each panel's cast and (under
   * `lettering: model`) the lines it letters are all derived from this list, so editing it
   * re-renders the page.
   */
  panels?: PagePanel[];
  /**
   * The staging-sheet group this shot is drawn from, one of its storyboard's
   * `ProductionData.sheets` keys.
   * Authored, and in the task's params through the sheet's key, so moving a shot between groups
   * re-renders it.
   */
  sheet?: string;
  /** Override of this frame's derived prompt. Authored, like {@link artNotes}. */
  promptOverride?: PromptOverride;
  /** Dialogue line ids this shot covers. */
  coversLines: string[];
  /** Filled in P6. */
  prompt?: string;
  /** Asset hash, filled in P7. */
  image?: string;
  /**
   * Hash of the text of the lines this shot covered at the moment {@link image} was produced.
   * A shot has drifted when that disagrees with the same hash computed from the scene now; see
   * `@vn/stills`' `driftOf`. Absent on a shot rendered before the field existed, which
   * reads as unknown and never as drifted.
   */
  proseHash?: string;
  /**
   * The panel boxes a reviewer saw in {@link image}, in reading order. Derived and recorded
   * beside the image, like {@link proseHash}; the intended geometry stays in {@link panels}, and
   * nothing downstream reads these. Absent on a frame, on an unrendered page, and on a page no
   * reviewer measured.
   */
  panelBoxes?: PanelBox[];
}

/** A subject (character + outfit + pose/expression) appearing in a shot. */
export interface ShotSubject {
  characterId: string;
  /**
   * This shot's own outfit override. Absent means inherit, first from the scene's `[[outfit:]]`
   * marker and then from the character's default, so the decomposer deliberately leaves it unset.
   * `@vn/model`'s `outfitFor` is the only place that chain is written down.
   */
  outfit?: string;
  pose?: string;
  expression?: string;
}
