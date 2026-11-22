import { variantEntries, wardrobeEntries, type CharacterEdit, type LocationEdit } from '@vn/model';
import type { PromptRung } from '@vn/stills';
import type { LocationVariant, Outfit, PromptOverride, Shot } from '@vn/types';
import type { LoadedProject } from '../load/project.js';

/** An outfit with one field changed, in the shape `wardrobeEntries` re-serializes. */
export function withOutfit(outfit: Outfit, patch: Partial<Outfit>): Outfit {
  const next = { ...outfit, ...patch };
  if (!next.artNotes) delete next.artNotes;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/** The same for a variant. */
export function withVariant(
  variant: LocationVariant,
  patch: Partial<LocationVariant>,
): LocationVariant {
  const next = { ...variant, ...patch };
  if (!next.artNotes) delete next.artNotes;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/** A shot with its prompt override set, or removed when the edit settled on nothing. */
export function withPromptOverride(shot: Shot, override: PromptOverride | undefined): Shot {
  const { promptOverride: _drop, ...rest } = shot;
  return override ? { ...rest, promptOverride: override } : rest;
}

/**
 * The character edit that applies one rung's prompt override. Clearing an override must be
 * stated explicitly: an empty override object is what `overrideData` serializes as a removed
 * key, so `undefined` here still produces an edit.
 */
export function characterOverrideEdit(
  project: LoadedProject,
  rung: Extract<PromptRung, { kind: 'character' | 'outfit' }>,
  override: PromptOverride | undefined,
): CharacterEdit {
  if (rung.kind === 'character') return { promptOverride: override ?? { mode: 'chunks' } };
  const character = project.model.characters.get(rung.characterId)!;
  return {
    outfits: wardrobeEntries(
      character.outfits.map((o) =>
        o.id === rung.outfit ? withOutfit(o, { promptOverride: override }) : o,
      ),
    ),
  };
}

/** The same for a location variant. */
export function locationOverrideEdit(
  project: LoadedProject,
  rung: Extract<PromptRung, { kind: 'variant' }>,
  override: PromptOverride | undefined,
): LocationEdit {
  const location = project.model.locations.get(rung.locationId)!;
  return {
    variants: variantEntries(
      location.variants.map((v) =>
        v.id === rung.variant ? withVariant(v, { promptOverride: override }) : v,
      ),
    ),
  };
}
