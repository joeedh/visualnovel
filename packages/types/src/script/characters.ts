/** Characters and their outfits, as the cast sheets under `wiki/` author them. */
import type { AssetRef } from '../assets.js';
import type { PromptOverride } from '../prompt.js';

/** Lifecycle of a character's "look" through the approval gate (report §P3). */
export type CharacterStatus = 'draft' | 'candidates' | 'approved' | 'locked';

/** A character outfit; the default outfit is produced by the model sheet (report §P4). */
export interface Outfit {
  id: string;
  /** Owning character id. */
  characterId: string;
  description: string;
  /** Art direction for this outfit alone — see {@link Character.artNotes}. */
  artNotes?: string;
  /** Image seed for this outfit's sheets — see {@link Character.seed}. */
  seed?: number;
  /** Image model for this outfit's sheets — see {@link Character.imageModel}. */
  imageModel?: string;
  /**
   * Override of this outfit's derived model-sheet prompt. The angle is recorded only on the task
   * and never on a rung, so one override covers all four angles of the sheet. The asset pane states that
   * coarseness rather than hiding it.
   */
  promptOverride?: PromptOverride;
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
  status: CharacterStatus;
  /** Outfit id used when a shot does not specify one. */
  defaultOutfit: string;
  outfits: Outfit[];
  /**
   * Free-form art direction appended to every prompt this character reaches — how the picture
   * should look, as opposed to {@link description}, which is who the character is. Authored, so
   * an agent can set it; part of the prompt, so changing it re-keys the tasks it reaches and the
   * next run re-renders exactly those.
   */
  artNotes?: string;
  /**
   * The image seed every prompt this character reaches is drawn with, overriding
   * `config.image_params.seed`. In `ImageParams`, so it is in the task hash: setting one
   * re-keys what it reaches and the next run redraws exactly that. Changing the seed asks for a
   * different picture of the same words, which {@link artNotes} cannot express. `@vn/stills`'
   * `seedFor` is the only place the narrowest-rung-wins chain is written down.
   */
  seed?: number;
  /**
   * The image model every picture this character reaches is drawn with, in place of the
   * project's `models.image`. Not in the task hash — a rendered picture stays until it is
   * regenerated, and the next render uses this model. `@vn/stills`' `modelFor` resolves the
   * same narrowest-rung-wins chain `seedFor` does.
   */
  imageModel?: string;
  /**
   * Override of this character's derived portrait prompt, the one picture this rung names.
   * A sheet's override lives on its {@link Outfit}, which is the rung that names that picture.
   */
  promptOverride?: PromptOverride;
  /** Asset hash of the user-approved portrait, once the gate is passed. */
  approvedPortrait?: string;
}
