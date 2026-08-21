/**
 * The rule for changing which variant of its scene's location a shot is set in.
 *
 * It lives here for the reason the outfit rules do: the desktop's `story.setVariant`, `vnauthor`'s
 * `set_variant` and any future timeline control must give the same answer, so the rule can live in
 * none of them. A shot's variant is a ref in its task hash, so a change re-renders that frame.
 */
import type { Location, Scene, Shot } from '@vn/types';
import type { ShotOutfitOp } from './outfits.js';

/** A variant list, quoted and comma-separated for a refusal sentence. */
const listed = (variants: readonly string[]): string =>
  variants.map((v) => `"${v}"`).join(', ') || 'none';

/**
 * Set which variant of the scene's location `shot` is drawn against. `location` must be the
 * location the scene is set in — a shot cannot leave its scene's location, only change the time of
 * day it is seen at.
 */
export function setShotVariant(
  shots: readonly Shot[],
  scene: Pick<Scene, 'id' | 'location'>,
  location: Location,
  args: { shot: string; variant: string },
): ShotOutfitOp {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return { ok: false, error: `No shot "${args.shot}" in ${scene.id}.` };
  if (location.id !== scene.location) {
    return {
      ok: false,
      error: `${scene.id} is set in "${scene.location}", not "${location.id}".`,
    };
  }
  const variants = location.variants.map((v) => v.id);
  if (!variants.includes(args.variant)) {
    return {
      ok: false,
      error: `"${location.id}" has no variant "${args.variant}" — it has ${listed(variants)}.`,
    };
  }
  if (shot.location === args.variant) {
    return { ok: false, error: `${args.shot} is already set in "${args.variant}".`, noop: true };
  }

  const next = shots.map((s) => (s.id === args.shot ? { ...s, location: args.variant } : s));
  return {
    ok: true,
    shots: next,
    message:
      `${args.shot} is now set in "${args.variant}". That is the plate it is drawn against, so ` +
      'the frame is drawn again on the next run.',
  };
}
