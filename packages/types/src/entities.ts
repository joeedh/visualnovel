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
 * A single beat of a scene — one dialogue line, action paragraph, parenthetical, or
 * narration. Each carries a stable, scene-scoped id (`${sceneId}:L<n>`) so shots can bind
 * to exact lines and a runner can swap art per line. Derived from the Fountain source at
 * model-build time (report §P5.1); not persisted independently.
 */
export interface SceneLine {
  /** Stable, scene-scoped id, e.g. `arrival:L3`. */
  id: string;
  kind: 'dialogue' | 'action' | 'parenthetical' | 'narration';
  /** Speaker character id; present for `dialogue`/`parenthetical` (and stage-direction action). */
  speaker?: string;
  text: string;
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
  camera?: string;
  /** Dialogue line ids this shot covers. */
  coversLines: string[];
  /** Filled in P6. */
  prompt?: string;
  /** Asset hash, filled in P7. */
  image?: string;
  status: 'pending' | 'prompted' | 'generated' | 'accepted' | 'needs_human';
}

/** A subject (character + outfit + pose/expression) appearing in a shot. */
export interface ShotSubject {
  characterId: string;
  outfit: string;
  pose?: string;
  expression?: string;
}

/** A scene = a graph node (report §6). */
export interface Scene {
  id: string;
  /** Location id (not variant) the scene takes place in. */
  location: string;
  characters: string[];
  /** Concise beat/synopsis for the LLM. */
  synopsis?: string;
  /** Narrative body (action + dialogue) for shot decomposition. */
  body: string;
  /**
   * Structured, ordered lines derived from the screenplay — the source of truth shots bind
   * to (via {@link Shot.coversLines}) and a runner replays. `body` is the lossy flattened
   * form kept for back-compat; `lines` preserves speaker/kind. Regenerated each model build.
   */
  lines: SceneLine[];
  /** Branch edges; empty for a leaf. */
  choices: Choice[];
  /** Linear continuation when there are no explicit choices. */
  next?: string;
  shots: Shot[];
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
  /** Which entity this asset satisfies, for the manifest index. */
  satisfies: {
    characterId?: string;
    outfit?: string;
    locationId?: string;
    variant?: string;
    sceneId?: string;
    shotId?: string;
  };
  accepted: boolean;
}
