/**
 * The narrative seam: what production asks of a story's structure, whichever engine authored it.
 * Production needs to know which scenes are worth drawing and in what order to list them; the
 * engine owns its own syntax, its validation and its idea of an entry scene.
 */
import type { Diagnostic } from '../diagnostic.js';
import type { Choice } from './scenes.js';

/**
 * The engines a project can select with `narrative:` in `project.yaml`. `branching` follows each
 * scene's `[[choice:]]` and `[[next:]]` markers from `start:`; `linear` plays the scenes `scenes:`
 * lists, in that order.
 */
export const NARRATIVE_ENGINES = ['branching', 'linear'] as const;

export type NarrativeEngine = (typeof NARRATIVE_ENGINES)[number];

/** Where play goes when a scene ends: one of the choices, or `next` when there are none. */
export interface SceneExits {
  choices: readonly Choice[];
  next?: string;
}

/** A project's story structure, as one engine reads it from the scenes. */
export interface NarrativeStructure {
  readonly engine: NarrativeEngine;
  /** The scene play starts at, or `undefined` when the engine could not settle one. */
  readonly entry: string | undefined;
  /**
   * Every scene id the model holds, once each, in the order a reader meets them: the live scenes
   * first, then the rest. Editors list scenes by it.
   */
  scenes(): readonly string[];
  /** Whether a scene is part of the story, and so worth producing art for. */
  live(sceneId: string): boolean;
  /** Where play goes when the scene ends; an id the model does not hold has no exits. */
  exits(sceneId: string): SceneExits;
  /** The engine's own findings about the structure: its markers, its order, its entry. */
  diagnostics(): readonly Diagnostic[];
}
