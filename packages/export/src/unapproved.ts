/**
 * The takes a playable would show that nobody has approved. `buildPlayable` projects the take
 * each slot holds and asks nothing about approval, so a host that publishes asks here first.
 */
import type { Asset, AssetStore, ProjectModel, Shot } from '@vn/types';
import { bindsTo } from '@vn/types';

export interface UnapprovedTake {
  /** The slot address: `shot:<sceneId>/<shotId>` or `portrait:<characterId>`. */
  slot: string;
  hash: string;
}

/**
 * Every shot whose current frame is unapproved, then every character cast in a scene whose
 * current portrait is, in the order the playable shows them. A slot with no take at all is not
 * listed: the player draws a placeholder for it, and there is nothing to approve.
 */
export function unapprovedTakes(
  model: ProjectModel,
  store: AssetStore,
  shots?: ReadonlyMap<string, readonly Shot[]>,
): UnapprovedTake[] {
  const assets = store.manifest();
  const out: UnapprovedTake[] = [];
  const current = (predicate: (a: Asset) => boolean): Asset | undefined =>
    assets.find((a) => a.current && predicate(a));

  for (const scene of model.scenes.values()) {
    const own = shots?.get(scene.id) ?? scene.shots;
    for (const shot of own) {
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

/** The refusal a host prints for the first unapproved take, or `undefined` when there is none. */
export function unapprovedSentence(takes: readonly UnapprovedTake[]): string | undefined {
  const first = takes[0];
  if (!first) return undefined;
  const more = takes.length > 1 ? ` and ${takes.length - 1} more` : '';
  return `${first.slot} holds a take nobody has approved (${first.hash.slice(0, 8)}…)${more}. Accept it, or put an approved take back, before exporting.`;
}
