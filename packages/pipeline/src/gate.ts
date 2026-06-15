import type { Character, ProjectModel } from '@vn/types';

/** A character look is usable downstream once it is approved or locked (report §P3). */
export function isApproved(character: Character): boolean {
  return (
    (character.status === 'approved' || character.status === 'locked') &&
    !!character.approvedPortrait
  );
}

/** A scene can have its shots generated only once every character in it is approved. */
export function sceneUnblocked(model: ProjectModel, sceneId: string): boolean {
  const scene = model.scenes.get(sceneId);
  if (!scene) return false;
  return scene.characters.every((id) => {
    const character = model.characters.get(id);
    return character ? isApproved(character) : false;
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
export function gateStatus(model: ProjectModel): GateStatus {
  const used = new Set<string>();
  for (const scene of model.scenes.values()) {
    if (!model.reachable.has(scene.id)) continue;
    for (const id of scene.characters) used.add(id);
  }
  const pending: string[] = [];
  const approved: string[] = [];
  for (const id of used) {
    const character = model.characters.get(id);
    if (character && isApproved(character)) approved.push(id);
    else pending.push(id);
  }
  return { pending: pending.sort(), approved: approved.sort(), cleared: pending.length === 0 };
}
