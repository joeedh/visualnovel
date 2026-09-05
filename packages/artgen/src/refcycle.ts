/**
 * The reference graph, and the cycle check over it (`docs/plans/archive/INDEX.md#chunked-prompts` §14).
 *
 * Enforcement is over references, not `Task.deps` — `deps` is incomplete and is not hashed, so a
 * ref cycle is invisible to `topoOrder`. The cycle is over logical slots rather than hashes: "Aiko's
 * portrait references Aiko's gala sheet" closes a loop even though no hash repeats, because the
 * sheet's prompt already references the portrait. Left unchecked, `doneOutput` answers `undefined`,
 * the shot is skipped, and the plan-run-replan loop starves in silence, so the check runs at write
 * time and the refusal names the path.
 */
import type { Asset, RefBinding } from '@vn/types';
import { outfitFor } from '@vn/model';
import { overrideAt, type PromptRung, type RungContext } from './resolve.js';
import { SHEET_FRONT } from './prompts.js';
import { slotKey, slotLabel } from './slotaddr.js';

/**
 * The slot an asset itself fills — what a cycle check starts from. The mirror of `rungOf`, but a
 * binding rather than a rung, because a sheet's angle is part of the picture and only the rung
 * collapses the angles together. `angle` is injected for the same reason `BindingContext.angleOf`
 * is: it lives in the task's inputs and never in `satisfies`.
 */
export function slotOf(asset: Asset, angle?: string): RefBinding | undefined {
  const b = asset.satisfies[0];
  if (!b) return undefined;
  switch (asset.kind) {
    case 'portrait':
      return b.characterId ? { kind: 'portrait', characterId: b.characterId } : undefined;
    case 'model_sheet':
    case 'outfit_sheet':
      return b.characterId && b.outfit
        ? {
            kind       : 'sheet',
            characterId: b.characterId,
            outfit     : b.outfit,
            angle      : angle ?? SHEET_FRONT,
          }
        : undefined;
    case 'location_ref':
      return b.locationId && b.variant
        ? { kind: 'plate', locationId: b.locationId, variant: b.variant }
        : undefined;
    case 'shot_image':
      return b.sceneId && b.shotId
        ? { kind: 'shot', sceneId: b.sceneId, shotId: b.shotId }
        : undefined;
    // A concept and an upload fill no slot: nothing plans them, so nothing can reference them by
    // anything but their hash.
    default:
      return undefined;
  }
}

/** The rung whose override governs a slot. The three angles of one outfit share one rung (§2). */
function rungFor(b: RefBinding): PromptRung | undefined {
  switch (b.kind) {
    case 'portrait':
      return { kind: 'character', characterId: b.characterId };
    case 'sheet':
      return { kind: 'outfit', characterId: b.characterId, outfit: b.outfit };
    case 'plate':
      return { kind: 'variant', locationId: b.locationId, variant: b.variant };
    case 'shot':
      return { kind: 'shot', sceneId: b.sceneId, shotId: b.shotId };
    case 'asset':
      return undefined;
  }
}

/** The references the planner derives for a slot, with no author involved (`planner.ts`). */
function derivedRefs(b: RefBinding, ctx: RungContext): RefBinding[] {
  switch (b.kind) {
    // A sheet is drawn from the character's approved portrait, always.
    case 'sheet':
      return [{ kind: 'portrait', characterId: b.characterId }];
    case 'shot': {
      const scene = ctx.model.scenes.get(b.sceneId);
      const shot = ctx.shots?.get(b.sceneId)?.find((s) => s.id === b.shotId);
      if (!scene || !shot) return [];
      const out: RefBinding[] = [
        { kind: 'plate', locationId: scene.location, variant: shot.location },
      ];
      for (const subject of shot.subjects) {
        const character = ctx.model.characters.get(subject.characterId);
        out.push({ kind: 'portrait', characterId: subject.characterId });
        const outfit = outfitFor(subject, scene, character);
        // Only a subject out of its default carries a sheet — the portrait shows the default.
        if (character && outfit.id !== character.defaultOutfit)
          out.push({
            kind       : 'sheet',
            characterId: subject.characterId,
            outfit     : outfit.id,
            angle      : SHEET_FRONT,
          });
      }
      return out;
    }
    // Plates and portraits are drawn from nothing, and an upload was never derived at all.
    default:
      return [];
  }
}

/** The references an author attached, from the slot's rung. A muted chunk contributes none (§12). */
function attachedSlots(b: RefBinding, ctx: RungContext): RefBinding[] {
  const rung = rungFor(b);
  const override = rung && overrideAt(rung, ctx);
  if (!override?.refs) return [];
  const muted = new Set(override.mute ?? []);
  const out: RefBinding[] = [];
  for (const [chunk, refs] of Object.entries(override.refs)) {
    if (muted.has(chunk)) continue;
    for (const ref of refs) if (ref.from) out.push(ref.from);
  }
  return out;
}

/** Every slot a slot points at today — what the planner derives plus what the author attached. */
export function refsOfSlot(b: RefBinding, ctx: RungContext): RefBinding[] {
  return [...derivedRefs(b, ctx), ...attachedSlots(b, ctx)];
}

/**
 * Whether attaching `candidate` to `from` would close a loop, and if so the path, named.
 *
 * Answers by asking whether `candidate` already reaches `from`; a shared upstream reached twice by
 * different routes is a diamond, not a cycle, so the `seen` set is over slots visited and the
 * search is a plain depth-first one. `visited` also makes the walk safe over a project that
 * somehow already holds a cycle, which is the same guarantee suspension's walk needs.
 */
export function refCycle(
  from: RefBinding,
  candidate: RefBinding,
  ctx: RungContext,
): RefBinding[] | undefined {
  const target = slotKey(from);
  const seen = new Set<string>();

  const walk = (at: RefBinding): RefBinding[] | undefined => {
    const key = slotKey(at);
    if (key === target) return [at];
    if (seen.has(key)) return undefined;
    seen.add(key);
    for (const next of refsOfSlot(at, ctx)) {
      const rest = walk(next);
      if (rest) return [at, ...rest];
    }
    return undefined;
  };

  const path = walk(candidate);
  return path ? [from, ...path] : undefined;
}

/** Representative angle for a sheet slot: an outfit's three sheets share one rung and one set of edges. */
const ANY_ANGLE = SHEET_FRONT;

/** Every slot an author attached a reference at — the only slots a cycle can pass through. */
function authoredSlots(ctx: RungContext): RefBinding[] {
  const out: RefBinding[] = [];
  for (const c of ctx.model.characters.values()) {
    if (c.promptOverride?.refs) out.push({ kind: 'portrait', characterId: c.id });
    for (const o of c.outfits)
      if (o.promptOverride?.refs)
        out.push({ kind: 'sheet', characterId: c.id, outfit: o.id, angle: ANY_ANGLE });
  }
  for (const l of ctx.model.locations.values())
    for (const v of l.variants)
      if (v.promptOverride?.refs) out.push({ kind: 'plate', locationId: l.id, variant: v.id });
  for (const [sceneId, shots] of ctx.shots ?? [])
    for (const s of shots ?? [])
      if (s.promptOverride?.refs) out.push({ kind: 'shot', sceneId, shotId: s.id });
  return out;
}

/**
 * A cycle already on disk, if there is one. `prompt.addRef` refuses before one can be written, so
 * this only fires on a hand-edited or otherwise corrupt project — and the planner calls it so that
 * such a project fails loudly instead of starving the plan-run-replan loop in silence (§14).
 */
export function firstCycle(ctx: RungContext): RefBinding[] | undefined {
  for (const slot of authoredSlots(ctx))
    for (const next of refsOfSlot(slot, ctx)) {
      const path = refCycle(slot, next, ctx);
      if (path) return path;
    }
  return undefined;
}

/** The refusal sentence for a cycle. Names every hop, where `topoOrder`'s cycle error names none. */
export function cycleRefusal(path: readonly RefBinding[]): string {
  return `that reference would close a loop: ${path.map(slotLabel).join(' → ')}`;
}
