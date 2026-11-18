/**
 * Scenes, their lines and their branch edges: what the screenplay says. Nothing here may name
 * a production type, because a scene exists before anything is drawn of it.
 */

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
 * The local part is allocated rather than positional: `[[line: L4]]` in the source names it,
 * and an unmarked line takes the next id from {@link Scene.nextLineId}. Inserting a line
 * therefore leaves every other line's id alone.
 */
export interface SceneLine {
  /** Stable, scene-scoped id, e.g. `arrival:L3`. */
  id: string;
  /**
   * Every kind can be covered by a shot. Only `dialogue`/`parenthetical` are attributed.
   * Only `transition` produces no beat in the playable, because a transition is a cut rather
   * than something a reader is shown.
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

/** A scene, which is one node of the branch graph (report §6). */
export interface Scene {
  id: string;
  /** Location id (not variant) the scene takes place in. */
  location: string;
  /**
   * Time-of-day variant the heading named (the `AFTERNOON` of `INT. GATE - AFTERNOON`), slugged.
   * The location plate is generated from this variant, so losing it changes the art.
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
   * scene says. Shots bind to it (via `Shot.coversLines`), the runner replays it, and
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
}
