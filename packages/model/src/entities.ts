import {
  characterFrontMatter,
  locationFrontMatter,
  type Character,
  type Diagnostic,
  type Location,
  type Outfit,
} from '@vn/types';
import type { FrontMatterDoc } from '@vn/parse';

/** A parsed entity, or the diagnostic explaining why a doc was rejected. */
export type EntityResult<T> = { ok: true; value: T } | { ok: false; diagnostic: Diagnostic };

/** Build a Character from a parsed `character.md` doc; body is the canonical description. */
export function characterFromDoc(doc: FrontMatterDoc): EntityResult<Character> {
  const parsed = characterFrontMatter.safeParse(doc.data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'character_frontmatter',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        where: typeof doc.data['id'] === 'string' ? (doc.data['id'] as string) : undefined,
      },
    };
  }
  const fm = parsed.data;
  const defaultOutfit: Outfit = {
    id: fm.default_outfit,
    characterId: fm.id,
    description: 'default outfit',
  };
  const character: Character = {
    id: fm.id,
    name: fm.name,
    description: doc.body.trim(),
    traits: fm.traits,
    palette: fm.palette,
    referenceImages: fm.reference_images,
    status: fm.status,
    defaultOutfit: fm.default_outfit,
    outfits: [defaultOutfit],
    approvedPortrait: fm.approved_portrait,
  };
  return { ok: true, value: character };
}

/** Build a user-authored Location from a parsed `locations/<id>.md` doc. */
export function locationFromDoc(doc: FrontMatterDoc): EntityResult<Location> {
  const parsed = locationFrontMatter.safeParse(doc.data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'location_frontmatter',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        where: typeof doc.data['id'] === 'string' ? (doc.data['id'] as string) : undefined,
      },
    };
  }
  const fm = parsed.data;
  const location: Location = {
    id: fm.id,
    name: fm.name,
    description: doc.body.trim(),
    mood: fm.mood,
    lighting: fm.lighting,
    palette: fm.palette,
    variants: fm.variants.map((id) => ({ id, description: '' })),
    mined: false,
  };
  return { ok: true, value: location };
}
