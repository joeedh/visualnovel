/**
 * Core domain entities (report §3). Each entity is backed by a markdown/JSON file
 * on disk; these are the in-memory shapes the rest of the system manipulates.
 */

/** Lifecycle of a character's "look" through the approval gate (report §P3). */
export type CharacterStatus = 'draft' | 'candidates' | 'approved' | 'locked';

/** Kinds of generated image assets (report §3, §7). */
export type AssetKind = 'location_ref' | 'portrait' | 'model_sheet' | 'outfit_sheet' | 'shot_image';

/** A reference to a stored asset by its content hash. */
export interface AssetRef {
  /** sha256 content hash of the asset bytes. */
  hash: string;
  /** File extension without the dot, e.g. `png`. */
  ext: string;
}

/** Image-generation parameters that participate in the dedupe hash. */
export interface ImageParams {
  modelId: string;
  aspect?: string;
  seed?: number;
  /** Free-form, model-specific extra params; hashed verbatim. */
  extra?: Record<string, string | number | boolean>;
}

/** A character outfit; the default outfit is produced by the model sheet (report §P4). */
export interface Outfit {
  id: string;
  /** Owning character id. */
  characterId: string;
  description: string;
  /** Model-sheet angle/expression images for this outfit, by label. */
  sheet?: Record<string, AssetRef>;
}

/** A character (report §3, §P3). */
export interface Character {
  id: string;
  name: string;
  /** Canonical, authoritative description fed to the LLM/image model. */
  description: string;
  traits: string[];
  /** Hex color palette injected into prompts for consistency. */
  palette: string[];
  /** User-supplied reference image paths (optional, relative to project root). */
  referenceImages: string[];
  status: CharacterStatus;
  /** Outfit id used when a shot does not specify one. */
  defaultOutfit: string;
  outfits: Outfit[];
  /** Asset hash of the user-approved portrait, once the gate is passed. */
  approvedPortrait?: string;
}

/** A time-of-day / weather variant of a location (report §P1, §P2). */
export interface LocationVariant {
  /** e.g. `day`, `afternoon`, `night`, `rain`. */
  id: string;
  description: string;
  /** Establishing/reference image once generated. */
  ref?: AssetRef;
}

/** A location (report §3, §P1). */
export interface Location {
  id: string;
  name: string;
  description: string;
  mood?: string;
  lighting?: string;
  palette: string[];
  variants: LocationVariant[];
  /** True when mined from the screenplay rather than user-authored. */
  mined: boolean;
}

/** A branch edge from one scene to another (report §6). */
export interface Choice {
  label: string;
  goto: string;
}

/**
 * A single beat of a scene — one dialogue line, narration paragraph, parenthetical,
 * transition, lyric or centered line. Each carries a stable, scene-scoped id
 * (`${sceneId}:L<n>`) so shots can bind to exact lines and a runner can swap art per line.
 * Derived from the Fountain source at model-build time (report §P5.1); not persisted
 * independently.
 *
 * The local part is **allocated**, not positional: `[[line: L4]]` in the source names it,
 * and anything unmarked takes the next id from {@link Scene.nextLineId}. Inserting a line
 * therefore leaves every other line's id alone.
 */
export interface SceneLine {
  /** Stable, scene-scoped id, e.g. `arrival:L3`. */
  id: string;
  /**
   * Every kind is **coverable** by a shot. Only `dialogue`/`parenthetical` are attributed,
   * and only `transition` produces no beat in the playable — it is a cut, not something a
   * reader is shown.
   */
  kind: 'dialogue' | 'parenthetical' | 'narration' | 'transition' | 'lyric' | 'centered';
  /** Speaker character id; present for `dialogue`/`parenthetical` and nothing else. */
  speaker?: string;
  text: string;
}

/**
 * The interior/exterior prefix a scene heading opens with, normalized to its canonical
 * spelling. Absent for a forced (`.HEADING`) heading, which has no prefix to keep.
 */
export type HeadingPrefix = 'INT.' | 'EXT.' | 'INT./EXT.' | 'EST.' | 'I/E';

/**
 * Whether a shot's rendered frame still illustrates the words it covers. Derived on every read
 * by `@vn/pipeline`'s `driftOf` and never persisted — a stored flag can be stale, a hash cannot.
 * The shape lives here because the timeline, the task list and the inspector all name it.
 */
export type Drift =
  /** No image yet, so there is nothing that could be stale. */
  | 'unrendered'
  /** The recorded prose hash matches: this frame was made from these words. */
  | 'current'
  /** It does not. The frame stands, and nothing will replace it unasked. */
  | 'drifted'
  /** Rendered before {@link Shot.proseHash} existed. Unanswerable, and not to be guessed. */
  | 'unknown';

/** A single rendered image within a scene (report §3, §P5). */
export interface Shot {
  id: string;
  /** Parent scene id. */
  sceneId: string;
  framing: 'wide' | 'medium' | 'close' | 'establishing';
  /** Location variant id this shot is set in. */
  location: string;
  subjects: ShotSubject[];
  camera?: string;
  /** Dialogue line ids this shot covers. */
  coversLines: string[];
  /** Filled in P6. */
  prompt?: string;
  /** Asset hash, filled in P7. */
  image?: string;
  /**
   * Hash of the text of the lines this shot covered at the moment {@link image} was produced.
   * A shot is *drifted* when that disagrees with the same hash computed from the scene now —
   * see `@vn/pipeline`'s `driftOf`. Absent on a shot rendered before the field existed, which
   * reads as unknown and never as drifted.
   */
  proseHash?: string;
  status: 'pending' | 'prompted' | 'generated' | 'accepted' | 'needs_human';
}

/** A subject (character + outfit + pose/expression) appearing in a shot. */
export interface ShotSubject {
  characterId: string;
  /**
   * This shot's own outfit **override**, and nothing weaker. Absent means inherit — the scene's
   * `[[outfit:]]` marker, then the character's default — so it is deliberately not filled in by
   * the decomposer. `@vn/model`'s `outfitFor` is the only place that chain is written down.
   */
  outfit?: string;
  pose?: string;
  expression?: string;
}

/** A scene = a graph node (report §6). */
export interface Scene {
  id: string;
  /** Location id (not variant) the scene takes place in. */
  location: string;
  /**
   * Time-of-day variant the heading named (`INT. GATE - **AFTERNOON**`), slugged. It is the
   * variant the location plate is generated from, so losing it changes the art.
   */
  locationVariant?: string;
  /** The heading's interior/exterior prefix; absent when the heading was forced with `.`. */
  headingPrefix?: HeadingPrefix;
  characters: string[];
  /**
   * Outfits the scene puts its cast in, character id → outfit id, from `[[outfit: aiko=uniform]]`
   * markers. Scene-scoped wherever the marker sits: a mid-scene change of clothes is a shot-level
   * override or a scene split, never a position in {@link lines}.
   */
  outfits?: Record<string, string>;
  /** Concise beat/synopsis for the LLM. */
  synopsis?: string;
  /**
   * The scene's prose as structured, ordered lines — the single representation of what the
   * scene says. Shots bind to it (via {@link Shot.coversLines}), the runner replays it, and
   * `sceneToFountain` writes it back out. Regenerated each model build.
   */
  lines: SceneLine[];
  /**
   * Monotonic high-water mark for this scene's line-id allocator — the next local id to
   * hand out. Read from `[[nextline: n]]` when present, otherwise derived as
   * `max(allocated) + 1`. Retired ids are never reused, so it only ever rises.
   */
  nextLineId?: number;
  /** Branch edges; empty for a leaf. */
  choices: Choice[];
  /** Linear continuation when there are no explicit choices. */
  next?: string;
  shots: Shot[];
}

/** What an asset is *for*: the entity, scene or shot it serves. */
export interface AssetBinding {
  characterId?: string;
  outfit?: string;
  locationId?: string;
  variant?: string;
  sceneId?: string;
  shotId?: string;
}

/** A stored, generated image and its provenance (report §3, §8). */
export interface Asset {
  hash: string;
  ext: string;
  kind: AssetKind;
  /** Task hash that produced it. */
  sourceTask: string;
  prompt?: string;
  /** Reference asset hashes fed into the generation, in order. */
  refs: string[];
  modelId: string;
  params?: ImageParams;
  /**
   * Everything this asset satisfies, for the manifest index. A list because bytes are keyed by
   * content: two tasks that produce the same image share one record, and the second binding
   * must not erase the first. A manifest written with a single record reads as one element.
   */
  satisfies: AssetBinding[];
  accepted: boolean;
}

/**
 * Whether `asset` serves everything `binding` names — one place to ask, so the surfaces don't
 * each spell the list traversal differently. An empty `binding` matches any bound asset.
 */
export function bindsTo(asset: Asset, binding: AssetBinding): boolean {
  const wanted = Object.entries(binding).filter(([, v]) => v !== undefined);
  return asset.satisfies.some((b) => wanted.every(([k, v]) => b[k as keyof AssetBinding] === v));
}
