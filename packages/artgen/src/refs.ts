/**
 * What a linked reference points at today (`docs/plans/archive/chunked-prompts.md` §11).
 *
 * A `ChunkRef` pins a hash — that is what is fed to the model, and what the task hashes over — and
 * *separately* remembers the slot it came from. Keeping both is the whole design: a live lookup
 * would silently re-key every task downstream of an approval, so the pin stays put and the binding
 * is re-resolved only when something asks. This module is that lookup, and the comparison over it.
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
 * authored order — what a task's `refs` gets **after** everything the planner derived (§12).
 *
 * Derived-first is the only ordering that leaves a project authoring none byte-identical, because
 * `canonicalJson` maps arrays positionally and `refs` is inside the task hash. A muted chunk
 * contributes nothing: its clause is not being sent, so neither is its evidence.
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
   * the same seam `labelAssets` uses. Absent, a `sheet` binding resolves only when the outfit
   * has exactly one sheet.
   */
  angleOf?: (sourceTask: string | undefined) => string | undefined;
}

/**
 * Pick the one asset a slot holds, or `undefined` when the answer is not certain.
 *
 * An accepted candidate wins outright — that is a human saying "this one". Failing that the slot
 * answers only when a single candidate serves it: the manifest is written hash-sorted, so among
 * equals list order carries no recency and guessing would be worse than declining. Every caller
 * treats "cannot say" as "make no claim", never as "the slot is empty".
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
 * this at all" are different questions and `pick` deliberately declines the first one whenever the
 * answer is not certain. A slot holding three unaccepted drafts resolves to `undefined` and would
 * read as empty; it is not, and the slot graph has to tell those two apart to say whether a picture
 * is awaiting approval or has yet to be rendered.
 *
 * A `portrait` slot answers from the **manifest** here, unlike `resolveBinding`, which reads the
 * gate off the model. Both are right: the gate says which portrait is *the* portrait, and this says
 * what has been drawn for the character.
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
    // An upload and a concept have no slot under them: the hash *is* the identity, so this is a
    // fixed point by construction and can never drift.
    case 'asset':
      return binding.hash;
    // The portrait is the one slot the model states outright — the gate writes it onto the sheet,
    // so the manifest never has to be consulted.
    case 'portrait':
      return ctx.model.characters.get(binding.characterId)?.approvedPortrait;
    default:
      return pick(candidatesFor(binding, ctx));
  }
}

/**
 * Whether the slot has moved out from under a pinned reference — reported on screen, never acted
 * on. An unlinked reference has no slot and so never drifts; a slot that cannot be resolved makes
 * no claim either way, because "I don't know" must not read as "it changed".
 */
export function refDrift(ref: ChunkRef, ctx: BindingContext): boolean {
  if (!ref.from) return false;
  const now = resolveBinding(ref.from, ctx);
  return now !== undefined && now !== ref.pin;
}
