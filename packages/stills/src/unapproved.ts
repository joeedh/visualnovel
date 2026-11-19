/**
 * The takes a playable would show that nobody has approved. `buildPlayable` projects the take
 * each slot holds and asks nothing about approval, so a host that publishes lists them here and
 * hands the list to `@vn/export`'s `unapprovedSentence`.
 */
import type { Asset, ProjectModel } from '@vn/types';
import { bindsTo, shotsOf } from '@vn/types';

export interface UnapprovedTake {
  /** The slot address: `shot:<sceneId>/<shotId>` or `portrait:<characterId>`. */
  slot: string;
  hash: string;
}

/**
 * Lists every shot whose current frame is unapproved, then every character cast in a scene whose
 * current portrait is, in the order the playable shows them. Every scene is walked, reachable or
 * not, because the playable carries every scene. A slot with no take at all is not listed: the
 * player draws a placeholder for it, and there is nothing to approve.
 */
export function unapprovedTakes(model: ProjectModel, assets: readonly Asset[]): UnapprovedTake[] {
  const out: UnapprovedTake[] = [];
  const current = (predicate: (a: Asset) => boolean): Asset | undefined =>
    assets.find((a) => a.current && predicate(a));

  for (const scene of model.scenes.values()) {
    for (const shot of shotsOf(model, scene.id)) {
      const frame = current((a) => a.kind === 'shot_image' && bindsTo(a, { shotId: shot.id }));
      if (frame && !frame.accepted)
        out.push({ slot: `shot:${scene.id}/${shot.id}`, hash: frame.hash });
    }
  }

  const cast = new Set<string>();
  for (const scene of model.scenes.values()) for (const id of scene.characters) cast.add(id);
  for (const id of cast) {
    const character = model.characters.get(id);
    // A locked character's approval is the sheet's, whatever the slot holds
    if (!character || character.status === 'locked') continue;
    const portrait = current((a) => a.kind === 'portrait' && bindsTo(a, { characterId: id }));
    if (portrait && !portrait.accepted) out.push({ slot: `portrait:${id}`, hash: portrait.hash });
  }
  return out;
}
