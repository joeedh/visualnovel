/**
 * The character-approval gate (report §P3), read off the manifest row where a manifest is in hand
 * and off the character sheet's mirror where none is. The row is the authority: `accept` on the
 * portrait a slot holds writes the sheet's `status: approved` and `approved_portrait:` in the
 * same act, so the two agree wherever both are read, and a pure plan with no store reads the
 * mirror alone. `status: locked` is the one thing the sheet says on its own: it holds the
 * character's approval with the hash the sheet names, whatever the slot holds.
 */
import { bindsTo, type Asset, type Character, type ProjectModel } from '@vn/types';

/** The hash the sheet's mirror names, when its status says it is approved. */
function mirrored(character: Character): string | undefined {
  return (character.status === 'approved' || character.status === 'locked') &&
    character.approvedPortrait
    ? character.approvedPortrait
    : undefined;
}

/**
 * The portrait a character's look is approved with, or `undefined` while the gate is closed for
 * them. With a manifest, the current take of the character's portrait slot when a person accepted
 * it; a re-render puts an unapproved draft in the slot, and the gate closes until the author
 * accepts it or restores the approved one. A `locked` character answers from the sheet alone.
 */
export function approvedPortraitOf(
  character: Character,
  assets?: readonly Asset[],
): string | undefined {
  if (assets === undefined || character.status === 'locked') return mirrored(character);
  const row = assets.find(
    (a) =>
      a.kind === 'portrait' &&
      a.current === true &&
      a.accepted &&
      bindsTo(a, { characterId: character.id }),
  );
  return row?.hash;
}

/** A character look is usable downstream once it is approved or locked (report §P3). */
export function isApproved(character: Character, assets?: readonly Asset[]): boolean {
  return approvedPortraitOf(character, assets) !== undefined;
}

/** A scene can have its shots generated only once every character in it is approved. */
export function sceneUnblocked(
  model: ProjectModel,
  sceneId: string,
  assets?: readonly Asset[],
): boolean {
  const scene = model.scenes.get(sceneId);
  if (!scene) return false;
  return scene.characters.every((id) => {
    const character = model.characters.get(id);
    return character ? isApproved(character, assets) : false;
  });
}

/** The character-approval gate state (report §P3) — what's blocking shot generation. */
export interface GateStatus {
  /** Characters still awaiting human approval of their portrait. */
  pending: string[];
  /** Characters whose look is approved/locked. */
  approved: string[];
  /** True when every character used by a reachable scene is approved. */
  cleared: boolean;
}

/**
 * Summarize the character gate (report §P3, §10). Only characters that actually appear in
 * a reachable scene matter — an unused character never blocks the run.
 */
export function gateStatus(model: ProjectModel, assets?: readonly Asset[]): GateStatus {
  const used = new Set<string>();
  for (const scene of model.scenes.values()) {
    if (!model.reachable.has(scene.id)) continue;
    for (const id of scene.characters) used.add(id);
  }
  const pending: string[] = [];
  const approved: string[] = [];
  for (const id of used) {
    const character = model.characters.get(id);
    if (character && isApproved(character, assets)) approved.push(id);
    else pending.push(id);
  }
  return { pending: pending.sort(), approved: approved.sort(), cleared: pending.length === 0 };
}
