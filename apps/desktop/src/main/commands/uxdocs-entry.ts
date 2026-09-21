/**
 * The entrypoint `scripts/gen-ux-docs.mjs` bundles and requires. It holds the registry side of
 * the UX docs tree and runs the fold and the render, because the script cannot import a
 * TypeScript module directly. Kept separate from `catalog-entry.ts` because the pages open with
 * the doc index, whose `notes` must never ride through the runtime catalog's code path.
 */
import {
  toDocIndex,
  toEffectCatalog,
  toInteractionCatalog,
  type DocCommandEntry,
  type EffectCatalogEntry,
  type InteractionCatalogEntry,
} from '@vn/commands';
import { fold, render, UX_ANCHORS } from '../../shared/uxdocs.js';
import { UX_MODEL } from '../../shared/uxmodel.js';
import { desktopEffects } from './catalog-entry.js';
import { createDesktopRegistry } from './index.js';
import { desktopInteractions } from './interaction.js';

export interface UxCatalogs {
  docs: DocCommandEntry[];
  interactions: InteractionCatalogEntry[];
  effects: EffectCatalogEntry[];
}

/** The three registry projections `fold` takes beside the model and the sweep. */
export function uxCatalogs(): UxCatalogs {
  const commands = createDesktopRegistry();
  desktopInteractions.verify(commands);
  desktopEffects.verify(commands, desktopInteractions);
  return {
    docs        : toDocIndex(commands),
    interactions: toInteractionCatalog(desktopInteractions),
    effects     : toEffectCatalog(desktopEffects),
  };
}

/**
 * Every page of the tree from a model and a sweep, both handed in as the parsed JSON the
 * generator read. Both are parsed here again, so a stale or hand-edited file fails by field.
 */
export function uxPages(model: unknown, anchors: unknown): Map<string, string> {
  const { docs, interactions, effects } = uxCatalogs();
  return render(
    fold(UX_MODEL.parse(model), UX_ANCHORS.parse(anchors), docs, interactions, effects),
  );
}
