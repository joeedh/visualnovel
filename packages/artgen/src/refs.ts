/**
 * What a linked reference points at today (`docs/plans/archive/chunked-prompts.md` §11).
 *
 * A `ChunkRef` pins a hash, which is what is fed to the model and what the task hashes over, and it
 * separately remembers the slot that hash came from. A live lookup would silently re-key every task
 * downstream of an approval, so the pin stays put and the binding is re-resolved only on request.
 * This module performs that re-resolution and the comparison against the pin.
 */
import {
  bindsTo,
  type Asset,
  type AssetRef,
  type ChunkRef,
  type ProjectModel,
  type PromptChunk,
  type PromptOverride,
  type RefBinding,
} from '@vn/types';
import { effectiveChunks } from './chunks.js';

/**
 * The references an author attached to this prompt, in effective chunk order and within a chunk in
 * authored order. These are appended to a task's `refs` after everything the planner derived (§12).
 *
 * Derived refs must come first, or a project that authors none stops hashing byte-identically:
 * `canonicalJson` maps arrays positionally and `refs` is inside the task hash. A muted chunk
 * contributes nothing, because its clause is not sent and neither are its references.
 */
export function authoredRefs(
  chunks: readonly PromptChunk[],
  o: PromptOverride | undefined,
): AssetRef[] {
  if (!o?.refs) return [];
  const out: AssetRef[] = [];
  for (const c of effectiveChunks(chunks, o)) {
    if (c.muted) continue;
    for (const ref of o.refs[c.key] ?? []) out.push({ hash: ref.pin, ext: ref.ext });
  }
  return out;
}

/** What resolving a binding reads. All of it is already loaded wherever this is called. */
export interface BindingContext {
  model: ProjectModel;
  /** The manifest, as read — both roots, since a slot may be filled from either. */
  assets: readonly Asset[];
  /**
   * The angle a model-sheet task was for. Injected because an angle is recorded in the task's
   * inputs and never in `Asset.satisfies`, so the manifest alone cannot tell four sheets apart;
   * the same seam `labelAssets` uses. Without it, a `sheet` binding resolves only when the outfit
   * has exactly one sheet.
   */
  angleOf?: (sourceTask: string | undefined) => string | undefined;
}

/**
 * Pick the one asset a slot holds, or `undefined` when the answer is not certain.
 *
 * A single accepted candidate wins outright, since accepting one is a human choosing it. Otherwise
 * the slot answers only when exactly one candidate serves it. The manifest is written hash-sorted,
 * so list order among unaccepted candidates carries no recency to guess from. Every caller reads
 * `undefined` as "no claim", never as "the slot is empty".
 */
function pick(candidates: readonly Asset[]): string | undefined {
  const accepted = candidates.filter((a) => a.accepted);
  if (accepted.length === 1) return accepted[0]!.hash;
  if (accepted.length > 1) return undefined;
  return candidates.length === 1 ? candidates[0]!.hash : undefined;
}

/**
 * Every asset bound to a slot, accepted or not — the set {@link pick} chooses from.
 *
 * Separate from {@link resolveBinding} because "which one is it" and "has anything been drawn for
 * this at all" are different questions, and `pick` declines the first whenever the answer is not
 * certain. A slot holding three unaccepted drafts resolves to `undefined` even though bytes exist,
 * and the slot graph has to tell those cases apart to say whether a picture is awaiting approval or
 * has yet to be rendered.
 *
 * A `portrait` slot answers from the manifest here, where `resolveBinding` reads the gate off the
 * model. The gate says which portrait is the approved one; this says what has been drawn for the
 * character.
 */
export function candidatesFor(binding: RefBinding, ctx: BindingContext): Asset[] {
  switch (binding.kind) {
    case 'asset':
      return ctx.assets.filter((a) => a.hash === binding.hash);
    case 'portrait':
      return ctx.assets.filter(
        (a) => a.kind === 'portrait' && bindsTo(a, { characterId: binding.characterId }),
      );
    case 'sheet': {
      const bound = ctx.assets.filter(
        (a) =>
          (a.kind === 'model_sheet' || a.kind === 'outfit_sheet') &&
          bindsTo(a, { characterId: binding.characterId, outfit: binding.outfit }),
      );
      return ctx.angleOf
        ? bound.filter((a) => ctx.angleOf!(a.sourceTask) === binding.angle)
        : bound;
    }
    case 'plate':
      return ctx.assets.filter(
        (a) =>
          a.kind === 'location_ref' &&
          bindsTo(a, { locationId: binding.locationId, variant: binding.variant }),
      );
    case 'shot':
      return ctx.assets.filter(
        (a) =>
          a.kind === 'shot_image' &&
          bindsTo(a, { sceneId: binding.sceneId, shotId: binding.shotId }),
      );
  }
}

/** The asset hash a binding names today, or `undefined` when nothing fills the slot. */
export function resolveBinding(binding: RefBinding, ctx: BindingContext): string | undefined {
  switch (binding.kind) {
    // An upload and a concept have no slot under them; the hash is the identity, so it cannot drift
    case 'asset':
      return binding.hash;
    // The gate writes the approved portrait onto the character sheet, so the model answers this one
    // and the manifest is not consulted
    case 'portrait':
      return ctx.model.characters.get(binding.characterId)?.approvedPortrait;
    default:
      return pick(candidatesFor(binding, ctx));
  }
}

/**
 * Whether the slot has moved out from under a pinned reference. This is reported on screen and
 * never acted on. An unlinked reference has no slot and so never drifts, and a slot that cannot be
 * resolved reports no drift, because an unknown answer must not read as a changed one.
 */
export function refDrift(ref: ChunkRef, ctx: BindingContext): boolean {
  if (!ref.from) return false;
  const now = resolveBinding(ref.from, ctx);
  return now !== undefined && now !== ref.pin;
}
