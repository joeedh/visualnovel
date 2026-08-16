/**
 * Art notes: which rung a note is written at, and which rungs reach a given asset.
 *
 * A note is authored input — the one thing an author can say about how generated art should
 * *look* — and it goes into the prompt, so setting one re-keys the tasks it reaches. There are
 * five rungs, and they are named with the document tree's `kind:key` vocabulary extended by one
 * `/sub` segment: `character:aiko`, `character:aiko/gala`, `location:cafe`, `location:cafe/night`,
 * `shot:greet/s2`. Both hosts speak it — the desktop's `art.setNotes` and `vnauthor`'s
 * `set_art_notes` — which is why the vocabulary lives here rather than in either. Pure: every fact
 * comes from the caller; {@link setArtNotes} is the half that touches disk.
 */
import type { Asset, ProjectModel, Shot } from '@vn/types';

/** One rung of the art-notes chain, parsed from (or formatted into) an `art.setNotes` target. */
export type ArtTarget =
  | { kind: 'character'; id: string; outfit?: string }
  | { kind: 'location'; id: string; variant?: string }
  | { kind: 'shot'; sceneId: string; shotId: string };

/** A rung as a surface shows it: what to call it, what it says, and how to address it. */
export interface ArtRung {
  target: string;
  /** What this rung is, in words — `Aiko`, `Aiko — gala`, `Café Mori — night`. */
  label: string;
  /** What is authored there today; absent means the rung exists but says nothing. */
  notes?: string;
}

/** `art.setNotes`'s target string for a rung. The inverse of {@link parseArtTarget}. */
export function formatArtTarget(target: ArtTarget): string {
  switch (target.kind) {
    case 'character':
      return `character:${target.id}${target.outfit ? `/${target.outfit}` : ''}`;
    case 'location':
      return `location:${target.id}${target.variant ? `/${target.variant}` : ''}`;
    case 'shot':
      return `shot:${target.sceneId}/${target.shotId}`;
  }
}

/**
 * Parse an `art.setNotes` target, or `undefined` when it names no rung this vocabulary has.
 * Syntax only — whether the thing named exists is the caller's question, and a different refusal.
 */
export function parseArtTarget(target: string): ArtTarget | undefined {
  const at = target.indexOf(':');
  if (at <= 0) return undefined;
  const kind = target.slice(0, at);
  const rest = target.slice(at + 1).split('/');
  const [id, sub, ...extra] = rest;
  if (!id || extra.length || sub === '') return undefined;

  if (kind === 'character') return sub ? { kind, id, outfit: sub } : { kind, id };
  if (kind === 'location') return sub ? { kind, id, variant: sub } : { kind, id };
  if (kind === 'shot') return sub ? { kind, sceneId: id, shotId: sub } : undefined;
  return undefined;
}

/** What a lookup of the rungs needs: the model for entities, the storyboards for shots. */
export interface ArtNotesContext {
  model: ProjectModel;
  /**
   * A scene's persisted shots, by scene id. Absent scenes — and the `null` a storyboard that
   * will not parse leaves — simply contribute no shot rung.
   */
  shots?: ReadonlyMap<string, readonly Shot[] | null>;
}

/** What a rung says today, or `undefined` when the rung does not exist at all. */
export function rungAt(target: ArtTarget, ctx: ArtNotesContext): ArtRung | undefined {
  const address = formatArtTarget(target);
  if (target.kind === 'character') {
    const character = ctx.model.characters.get(target.id);
    if (!character) return undefined;
    if (!target.outfit) return rung(address, character.name, character.artNotes);
    const outfit = character.outfits.find((o) => o.id === target.outfit);
    return outfit && rung(address, `${character.name} — ${outfit.id}`, outfit.artNotes);
  }
  if (target.kind === 'location') {
    const location = ctx.model.locations.get(target.id);
    if (!location) return undefined;
    if (!target.variant) return rung(address, location.name, location.artNotes);
    const variant = location.variants.find((v) => v.id === target.variant);
    return variant && rung(address, `${location.name} — ${variant.id}`, variant.artNotes);
  }
  const shot = ctx.shots?.get(target.sceneId)?.find((s) => s.id === target.shotId);
  return shot && rung(address, `${target.sceneId} · ${shot.id}`, shot.artNotes);
}

function rung(target: string, label: string, notes: string | undefined): ArtRung {
  return notes === undefined ? { target, label } : { target, label, notes };
}

/**
 * The rungs that reach one asset, widest first — the same order the prompt builders speak them
 * in, so a surface listing these is listing what actually went into the picture.
 *
 * A shot frame gets only its own rung. The character's and the location's reach it through the
 * sheets and plates it references, which were generated with them; offering those here would
 * invite an author to say the same thing twice.
 */
export function rungsFor(asset: Asset, ctx: ArtNotesContext): ArtRung[] {
  const binding = asset.satisfies[0];
  if (!binding) return [];
  const wanted: ArtTarget[] = [];
  switch (asset.kind) {
    case 'portrait':
      if (binding.characterId) wanted.push({ kind: 'character', id: binding.characterId });
      break;
    case 'model_sheet':
    case 'outfit_sheet':
      if (binding.characterId) {
        wanted.push({ kind: 'character', id: binding.characterId });
        if (binding.outfit) {
          wanted.push({ kind: 'character', id: binding.characterId, outfit: binding.outfit });
        }
      }
      break;
    case 'location_ref':
      if (binding.locationId) {
        wanted.push({ kind: 'location', id: binding.locationId });
        if (binding.variant) {
          wanted.push({ kind: 'location', id: binding.locationId, variant: binding.variant });
        }
      }
      break;
    case 'shot_image':
      if (binding.sceneId && binding.shotId) {
        wanted.push({ kind: 'shot', sceneId: binding.sceneId, shotId: binding.shotId });
      }
      break;
    case 'concept':
      // The entity rung and no lower one: a concept is bound to a character or a location and
      // never to an outfit or a variant, so there is no second rung to offer.
      if (binding.characterId) wanted.push({ kind: 'character', id: binding.characterId });
      else if (binding.locationId) wanted.push({ kind: 'location', id: binding.locationId });
      break;
  }
  return wanted.map((t) => rungAt(t, ctx)).filter((r): r is ArtRung => r !== undefined);
}
