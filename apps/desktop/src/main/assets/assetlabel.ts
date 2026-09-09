/**
 * What to call an asset on screen. A content hash is the asset's identity, not its name, so the
 * sidebar and the backlink panel say `Aiko — uniform / front` and fall back to the hash when two
 * assets would otherwise carry the same words. Pure: every fact comes from the caller.
 */
import type { AnyTask, Asset, AssetBinding, ProjectModel } from '@vn/types';

/** The lookups a label needs. `angleOf` exists because an angle is in the task, not the binding. */
export interface AssetLabelContext {
  model: ProjectModel;
  /**
   * The model-sheet angle a task was for. `Asset.satisfies` binds only `{characterId, outfit}`,
   * so four sheets share that binding and differ only in the angle.
   */
  angleOf?: (sourceTask: string | undefined) => string | undefined;
}

/** Builds the context from a loaded project: the model supplies names, the graph supplies angles. */
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

/** First 8 characters of the hash, used as the fallback name and as a collision suffix. */
const short = (hash: string): string => hash.slice(0, 8);

function nameOf(binding: AssetBinding, ctx: AssetLabelContext): string | undefined {
  if (binding.characterId) return ctx.model.characters.get(binding.characterId)?.name;
  if (binding.locationId) return ctx.model.locations.get(binding.locationId)?.name;
  return undefined;
}

/**
 * One asset's display name, or `undefined` when nothing in the model claims it. An asset whose
 * character has since been deleted has no name, and none is invented for it.
 */
export function assetLabel(asset: Asset, ctx: AssetLabelContext): string | undefined {
  const binding = asset.satisfies[0];
  // An upload's name is the one an author typed, or the file they picked. Nothing generated an
  // upload, so it carries no binding and a binding never names it
  if (asset.kind === 'reference') return asset.title || undefined;
  // A concept's name is also authored rather than derived, and a concept may legitimately carry no
  // binding, so the concept case is handled before a binding is required
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
 * Every asset's label, keyed by hash. Two assets that produce the same words both get a `(hash8)`
 * suffix, so a label is always unambiguous. An asset with no label falls back to `hash8.ext`,
 * which is what the tree showed before names existed.
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
