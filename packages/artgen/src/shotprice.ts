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
 * an image.
 */
export function priceShotChanges(
  ctx: SlotResolveContext,
  changes: readonly ShotChange[],
): ShotChangePrice {
  let moved = 0;
  let rendered = 0;
  for (const change of changes) {
    const before = ctx.shots?.get(change.sceneId)?.find((s) => s.id === change.shot.id);
    const scene = ctx.model.scenes.get(change.sceneId);
    if (!before || !scene) continue;
    const now = identityOf(change.sceneId, before.id, ctx);
    if (now === undefined) continue;

    const movedScene: Scene =
      change.location === undefined ? scene : { ...scene, location: change.location };
    const scenes = new Map(ctx.model.scenes).set(change.sceneId, movedScene);
    const shots = new Map(ctx.shots).set(
      change.sceneId,
      (ctx.shots?.get(change.sceneId) ?? []).map((s) =>
        s.id === change.shot.id ? change.shot : s,
      ),
    );
    const after = identityOf(change.sceneId, change.shot.id, {
      ...ctx,
      model: { ...ctx.model, scenes },
      shots,
    });
    if (after === now) continue;
    moved++;
    if (before.image !== undefined) rendered++;
  }
  return { moved, rendered };
}
