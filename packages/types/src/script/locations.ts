/** Locations and their time-of-day variants, as `locations/*.md` authors them. */
import type { AssetRef } from '../assets.js';
import type { PromptOverride } from '../prompt.js';

/** A time-of-day / weather variant of a location (report §P1, §P2). */
export interface LocationVariant {
  /** e.g. `day`, `afternoon`, `night`, `rain`. */
  id: string;
  description: string;
  /** Art direction for this variant alone — see `Character.artNotes`. */
  artNotes?: string;
  /** Image seed for this variant's plate — see `Character.seed`. */
  seed?: number;
  /** Image model for this variant's plate — see `Character.imageModel`. */
  imageModel?: string;
  /** Override of this variant's derived plate prompt — the one picture this rung names. */
  promptOverride?: PromptOverride;
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
  /** Art direction for every plate of this location — see `Character.artNotes`. */
  artNotes?: string;
  /** Image seed for every plate of this location — see `Character.seed`. */
  seed?: number;
  /** Image model for every plate of this location — see `Character.imageModel`. */
  imageModel?: string;
  /** True when mined from the screenplay rather than user-authored. */
  mined: boolean;
}
