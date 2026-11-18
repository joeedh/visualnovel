/**
 * What an edit costs the art: of the shots whose inputs it changes, how many will be drawn again,
 * and how many of those already have a frame. An entity delete's rule in `@vn/scriptedit` names
 * the changed shots; it cannot price them, because the task identity is computed here.
 */
import type { Scene, Shot } from '@vn/types';
import { resolveSlot, slotTaskHash, type SlotResolveContext } from './slotgraph.js';

/** One changed shot: as it will be, and its scene's location afterwards if that moves too. */
export interface ShotChange {
  sceneId: string;
  shot: Shot;
  location?: string;
}

/** How many changed shots will be drawn again, and how many of those already have a frame. */
export interface ShotChangePrice {
  moved: number;
  rendered: number;
}

/** Answers the shot's task identity in `ctx`, or undefined when it cannot be stated yet. */
function identityOf(sceneId: string, shotId: string, ctx: SlotResolveContext): string | undefined {
  const slot = resolveSlot({ kind: 'shot', sceneId, shotId }, ctx);
  return slot.ok ? slotTaskHash(slot.plan) : undefined;
}

/**
 * Prices `changes` against the project as it stands in `ctx`. A shot is counted when its identity
 * can be stated now and differs afterwards, or cannot be stated afterwards; one that cannot be
 * stated now has not been planned, so nothing is drawn again. It counts as rendered when it has
 * an image. A staging-sheet group is in every member's identity, so the other members of a group a
 * changed shot leaves or is in are priced the same way, each shot at most once.
 */
export function priceShotChanges(
  ctx: SlotResolveContext,
  changes: readonly ShotChange[],
): ShotChangePrice {
  let moved = 0;
  let rendered = 0;
  const changed = new Set(changes.map((c) => `${c.sceneId}/${c.shot.id}`));
  const counted = new Set<string>();
  const price = (sceneId: string, shot: Shot, after: SlotResolveContext): void => {
    const key = `${sceneId}/${shot.id}`;
    if (counted.has(key)) return;
    const now = identityOf(sceneId, shot.id, ctx);
    if (now === undefined || identityOf(sceneId, shot.id, after) === now) return;
    counted.add(key);
    moved++;
    if (shot.image !== undefined) rendered++;
  };

  for (const change of changes) {
    const board = ctx.shots?.get(change.sceneId) ?? [];
    const before = board.find((s) => s.id === change.shot.id);
    const scene = ctx.model.scenes.get(change.sceneId);
    if (!before || !scene) continue;

    const movedScene: Scene =
      change.location === undefined ? scene : { ...scene, location: change.location };
    const scenes = new Map(ctx.model.scenes).set(change.sceneId, movedScene);
    const shots = new Map(ctx.shots).set(
      change.sceneId,
      board.map((s) => (s.id === change.shot.id ? change.shot : s)),
    );
    const after = { ...ctx, model: { ...ctx.model, scenes }, shots };
    price(change.sceneId, before, after);

    const groups = new Set([before.sheet, change.shot.sheet]);
    for (const sibling of board) {
      if (sibling.sheet === undefined || !groups.has(sibling.sheet)) continue;
      if (!changed.has(`${change.sceneId}/${sibling.id}`)) price(change.sceneId, sibling, after);
    }
  }
  return { moved, rendered };
}
