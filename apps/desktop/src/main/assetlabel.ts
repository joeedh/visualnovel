/**
 * What to call an asset on screen. A content hash is the asset's identity, not its name, so the
 * sidebar and the backlink panel say `Aiko — uniform / front` and keep the hash for when two
 * assets would otherwise answer to the same words. Pure: every fact comes from the caller.
 */
import type { AnyTask, Asset, AssetBinding, ProjectModel } from '@vn/types';

/** The lookups a label needs. `angleOf` exists because an angle is in the task, not the binding. */
export interface AssetLabelContext {
  model: ProjectModel;
  /**
   * The model-sheet angle a task was for. `Asset.satisfies` binds only `{characterId, outfit}`
   * — four sheets share that binding and differ only here.
   */
  angleOf?: (sourceTask: string | undefined) => string | undefined;
}

/** The context a loaded project answers with — the model for names, the graph for angles. */
export function labelContext(
  model: ProjectModel,
  graph: { get(hash: string): AnyTask | undefined },
): AssetLabelContext {
  return {
    model,
    angleOf: (task) => {
      const node = task ? graph.get(task) : undefined;
      return node && 'angle' in node.inputs ? node.inputs.angle : undefined;
    },
  };
}

/** The fallback name, and the suffix a collision gets: the first 8 of the hash. */
const short = (hash: string): string => hash.slice(0, 8);

function nameOf(binding: AssetBinding, ctx: AssetLabelContext): string | undefined {
  if (binding.characterId) return ctx.model.characters.get(binding.characterId)?.name;
  if (binding.locationId) return ctx.model.locations.get(binding.locationId)?.name;
  return undefined;
}

/**
 * One asset's display name, or `undefined` when nothing in the model claims it — an asset whose
 * character has since been deleted has no name to give, and inventing one would be a lie about
 * what the manifest says.
 */
export function assetLabel(asset: Asset, ctx: AssetLabelContext): string | undefined {
  const binding = asset.satisfies[0];
  // An upload's name is the one an author typed, or the file they picked. It is bound to nothing
  // by construction — nothing generated it — so a binding is never what names it.
  if (asset.kind === 'reference') return asset.title || undefined;
  // A concept is the other kind whose name was authored rather than derived, and the other that may
  // legitimately be bound to nothing — so it answers before the binding is required.
  if (asset.kind === 'concept') {
    const of = binding ? nameOf(binding, ctx) : undefined;
    if (!asset.title) return of;
    return of ? `${of} — ${asset.title}` : asset.title;
  }
  if (!binding) return undefined;
  const name = nameOf(binding, ctx);

  switch (asset.kind) {
    case 'portrait':
      return name;
    case 'model_sheet':
    case 'outfit_sheet': {
      if (!name) return undefined;
      const angle = ctx.angleOf?.(asset.sourceTask);
      const outfit = binding.outfit ? ` — ${binding.outfit}` : '';
      return `${name}${outfit}${angle ? ` / ${angle}` : ''}`;
    }
    case 'location_ref':
      return name && binding.variant ? `${name} — ${binding.variant}` : name;
    case 'shot_image':
      return binding.sceneId && binding.shotId
        ? `${binding.sceneId} · ${binding.shotId}`
        : undefined;
  }
}

/**
 * Every asset's label, hash → label. Two assets that land on the same words both keep a
 * `(hash8)` suffix, so a label is never quietly ambiguous; one with no label at all falls back
 * to the `hash8.ext` the tree showed before names existed.
 */
export function labelAssets(assets: readonly Asset[], ctx: AssetLabelContext): Map<string, string> {
  const named = new Map<string, string | undefined>();
  const counts = new Map<string, number>();
  for (const asset of assets) {
    const label = assetLabel(asset, ctx);
    named.set(asset.hash, label);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  for (const asset of assets) {
    const label = named.get(asset.hash);
    if (!label) out.set(asset.hash, `${short(asset.hash)}.${asset.ext}`);
    else if ((counts.get(label) ?? 0) > 1) out.set(asset.hash, `${label} (${short(asset.hash)})`);
    else out.set(asset.hash, label);
  }
  return out;
}
