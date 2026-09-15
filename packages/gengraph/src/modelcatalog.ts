/**
 * The image models a picker lists, and the one snapshot both pickers read. The desktop shell sets
 * the snapshot from every `project.info` answer, so the Project editor's dropdown and the node
 * frames' `enumDef` draw the same list and the inherit row names the same model. Nothing here
 * reaches the filesystem; the file itself is read through `modelstore.ts`.
 */
import type { ImageModelEntry } from '@vn/types';

import { SHIPPED_PRICES } from './prices.js';

/** What the pickers draw: the shipped ids, the cached OpenRouter rows, and the project's model. */
export interface ModelCatalog {
  shipped: string[];
  openrouter: ImageModelEntry[];
  /** The project's `models.image`, which an empty node model draws with. */
  default: string;
  /** The day the OpenRouter rows were fetched; absent where no listing has been cached. */
  asOf?: string;
}

/** One row of an image-model picker: the id it writes, the text it shows, and its tooltip. */
export interface ImageModelChoice {
  id: string;
  label: string;
  tooltip: string;
}

/** The value of the row that leaves a node's model prop empty. */
export const INHERIT_VALUE = '';

let current: ModelCatalog | undefined;

/** Replaces the snapshot the pickers draw. `undefined` puts them back on the shipped list alone. */
export function setModelCatalog(catalog: ModelCatalog | undefined): void {
  current = catalog;
}

/** The snapshot as last set, or nothing before a project view has arrived. */
export function modelCatalog(): ModelCatalog | undefined {
  return current;
}

/**
 * Image models the shipped price table knows about, which every image-model picker lists first,
 * so the list can't drift from what estimates price.
 */
export function shippedImageModels(): string[] {
  return Object.keys(SHIPPED_PRICES.models).filter(
    (id) => SHIPPED_PRICES.models[id]?.image !== undefined,
  );
}

/** The inherit row's label: the project's model where a catalog names it. */
export function inheritLabel(catalog: ModelCatalog | undefined): string {
  return catalog?.default ? `Inherit (${catalog.default})` : 'Inherit (project image model)';
}

/**
 * The privacy clause an OpenRouter row carries. A Google model reached through OpenRouter is
 * drawn by the same vendor a direct call would reach, so only the routing is said of it.
 */
function routedClause(id: string): string {
  return id.startsWith('google/')
    ? 'routed by OpenRouter'
    : 'routed by OpenRouter; not zero-data-retention';
}

/** What one OpenRouter row's tooltip says: its price, its ratios, its seed, and how it is reached. */
export function openRouterTooltip(entry: ImageModelEntry): string {
  const price =
    entry.priceUsd === undefined
      ? 'no per-picture price listed'
      : `about $${entry.priceUsd.toFixed(3)} per picture`;
  const aspects =
    entry.aspects.length === 0 ? 'no aspect ratios declared' : entry.aspects.join(' ');
  const seed = entry.seed ? 'takes a seed' : 'no seed';
  return `${entry.name}: ${price}; ${aspects}; ${seed}; ${routedClause(entry.id)}.`;
}

/**
 * The rows a picker draws, in order: the inherit row where asked for, the shipped Gemini ids, the
 * cached OpenRouter ids in listing order, then `current` where it is none of those, so a model
 * that dropped off the listing is still shown rather than silently reset.
 */
export function imageModelChoices(
  catalog: ModelCatalog | undefined,
  current: string,
  opts: { inherit?: boolean } = {},
): ImageModelChoice[] {
  const rows: ImageModelChoice[] = [];
  if (opts.inherit) {
    rows.push({
      id     : INHERIT_VALUE,
      label  : inheritLabel(catalog),
      tooltip: 'Leave the model empty, so this node draws with the project’s image model.',
    });
  }
  for (const id of catalog?.shipped ?? shippedImageModels()) {
    rows.push({ id, label: id, tooltip: `Draw with ${id}, through Gemini.` });
  }
  for (const entry of catalog?.openrouter ?? []) {
    if (rows.some((row) => row.id === entry.id)) continue;
    rows.push({ id: entry.id, label: entry.id, tooltip: openRouterTooltip(entry) });
  }
  if (current !== '' && !rows.some((row) => row.id === current)) {
    rows.push({
      id     : current,
      label  : current,
      tooltip: current.includes('/')
        ? `Draw with ${current}, ${routedClause(current)}; it is not in the cached listing.`
        : `Draw with ${current}, through Gemini.`,
    });
  }
  return rows;
}
