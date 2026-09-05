/**
 * The two outfit rules: what a scene marker would change, and what a shot override would change.
 * Each also gives the sentence to refuse with when the edit would change nothing.
 *
 * Both rules live here because the desktop's `story.setOutfit` / `story.setSceneOutfit`,
 * `vnauthor`'s `set_outfit`, and the timeline's wardrobe strip must all give the same answer, so
 * the rule can live in none of them. The inheritance chain itself is not re-decided here:
 * `outfitFor` in `@vn/model` is the one place it is written down, and these two rules only say
 * what a change would do to it.
 */
import type { Character, Scene, Shot } from '@vn/types';
import { outfitFor, type SceneMarkerEdit } from '@vn/model';

/** Just enough of a character sheet to decide an outfit change, and to name the alternatives. */
export interface Wardrobe {
  defaultOutfit: string;
  /** Outfit ids in authored order; always contains {@link defaultOutfit}. */
  outfits: string[];
}

/** The wardrobes a decision is made against, keyed by character id. */
export type WardrobeMap = ReadonlyMap<string, Wardrobe>;

/**
 * The wardrobes of a model's cast. `characterFromDoc` synthesizes the default when the sheet's
 * map omits it, so the default is normally already in the list. It is added here anyway, so a
 * wardrobe can always name the value a clear falls back to; without it the clear is refused.
 */
export function wardrobesOf(characters: ReadonlyMap<string, Character>): WardrobeMap {
  const out = new Map<string, Wardrobe>();
  for (const [id, character] of characters) {
    const outfits = character.outfits.map((o) => o.id);
    if (!outfits.includes(character.defaultOutfit)) outfits.unshift(character.defaultOutfit);
    out.set(id, { defaultOutfit: character.defaultOutfit, outfits });
  }
  return out;
}

/** A scene-marker change, shaped so it can be handed straight to `session.editBranches`. */
export type SceneOutfitOp =
  | { ok: true; edits: SceneMarkerEdit[]; message: string }
  | { ok: false; error: string; noop?: boolean };

/** A shot-override change: the scene's shots as they would be written. */
export type ShotOutfitOp =
  { ok: true; shots: Shot[]; message: string } | { ok: false; error: string; noop?: boolean };

const refuse = (error: string, noop?: true): { ok: false; error: string; noop?: boolean } =>
  noop ? { ok: false, error, noop } : { ok: false, error };

/** A wardrobe's outfit ids, quoted and comma-separated for a refusal sentence. */
const listed = (outfits: readonly string[]): string =>
  outfits.map((o) => `"${o}"`).join(', ') || 'none';

/**
 * Check that `character` exists and can wear `outfit`, returning the refusal if not. An empty
 * outfit is the clear, which every wardrobe permits.
 */
function checkWardrobe(
  wardrobes: WardrobeMap,
  character: string,
  outfit: string,
): { error: string } | { wardrobe: Wardrobe } {
  const wardrobe = wardrobes.get(character);
  if (!wardrobe) return { error: `No character "${character}".` };
  if (outfit && !wardrobe.outfits.includes(outfit)) {
    return {
      error: `"${character}" has no outfit "${outfit}" — they have ${listed(wardrobe.outfits)}.`,
    };
  }
  return { wardrobe };
}

/**
 * Put `character` in `outfit` for the whole of `scene`, or clear the marker when `outfit` is
 * empty. The marker is scene-scoped wherever it sits, so this is a replacement of the scene's
 * whole marker set — which is also what makes the patch a single line to rewrite.
 */
export function setSceneOutfit(
  scenes: ReadonlyMap<string, Pick<Scene, 'id' | 'outfits'>>,
  wardrobes: WardrobeMap,
  args: { scene: string; character: string; outfit: string },
): SceneOutfitOp {
  const scene = scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);
  const checked = checkWardrobe(wardrobes, args.character, args.outfit);
  if ('error' in checked) return refuse(checked.error);

  const current = scene.outfits ?? {};
  const was = current[args.character];
  if ((was ?? '') === args.outfit) {
    return refuse(
      args.outfit
        ? `${scene.id} already puts "${args.character}" in "${args.outfit}".`
        : `${scene.id} says nothing about what "${args.character}" wears.`,
      true,
    );
  }

  const outfits = { ...current };
  if (args.outfit) outfits[args.character] = args.outfit;
  else delete outfits[args.character];

  const message = args.outfit
    ? `${scene.id} puts "${args.character}" in "${args.outfit}".`
    : `${scene.id} no longer says what "${args.character}" wears; ` +
      `they fall back to "${checked.wardrobe.defaultOutfit}".`;
  return { ok: true, edits: [{ sceneId: scene.id, outfits }], message };
}

/**
 * Override what one subject of one shot wears, or clear the override when `outfit` is empty.
 * Clearing is the fix for a shot decomposed before outfits were authorable: those carry an
 * explicit outfit, so they read as overrides and a scene marker cannot reach them.
 */
export function setShotOutfit(
  shots: readonly Shot[],
  scene: Pick<Scene, 'id' | 'outfits'>,
  wardrobes: WardrobeMap,
  args: { shot: string; character: string; outfit: string },
): ShotOutfitOp {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return refuse(`No shot "${args.shot}" in ${scene.id}.`);
  if (!shot.subjects.some((s) => s.characterId === args.character)) {
    return refuse(`Shot ${args.shot} has no subject "${args.character}".`);
  }
  const checked = checkWardrobe(wardrobes, args.character, args.outfit);
  if ('error' in checked) return refuse(checked.error);

  const subject = shot.subjects.find((s) => s.characterId === args.character) as {
    characterId: string;
    outfit?: string;
  };
  if ((subject.outfit ?? '') === args.outfit) {
    return refuse(
      args.outfit
        ? `${args.shot} already puts "${args.character}" in "${args.outfit}".`
        : `${args.shot} has no outfit override for "${args.character}".`,
      true,
    );
  }

  const next = shots.map((s) =>
    s.id !== args.shot
      ? s
      : {
          ...s,
          subjects: s.subjects.map((sub) => {
            if (sub.characterId !== args.character) return sub;
            const { outfit: _dropped, ...rest } = sub;
            return args.outfit ? { ...rest, outfit: args.outfit } : rest;
          }),
        },
  );

  // Name the fallback outfit and where it came from; saying only "it inherits" would leave the
  // author to work out whether the scene marker or the character sheet answered
  const inherited = outfitFor({ characterId: args.character }, scene, {
    defaultOutfit: checked.wardrobe.defaultOutfit,
  });
  const message = args.outfit
    ? `${args.shot} puts "${args.character}" in "${args.outfit}".`
    : `${args.shot} no longer overrides "${args.character}"; they wear "${inherited.id}" ` +
      `(from the ${inherited.origin === 'scene' ? 'scene marker' : 'character sheet'}).`;
  return { ok: true, shots: next, message };
}
