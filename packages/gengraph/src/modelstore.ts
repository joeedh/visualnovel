/**
 * Stores the cached OpenRouter image-model listing, per user rather than per project, in the
 * directory that holds the author's keys and price table.
 */
import { userConfigDir } from '@vn/config';
import type { UserDirEnv } from '@vn/config';
import { imageModelCatalog, type ImageModelCatalog } from '@vn/types';
import { ensureDir, join, readText, writeFileAtomic } from '@vn/util';

import type { GenPriceModels, GenPriceTable } from './prices.js';

/** The name an estimate attributes a line to when the listing priced it. */
export const OPENROUTER_PRICES_NAME = 'openrouter';

/** Where the listing is kept, beside the author's keys and price table. */
export function userModelFile(opts: UserDirEnv = {}): string {
  return join(userConfigDir(opts), 'models.json');
}

/**
 * The cached listing, or nothing when none has been fetched. A file that does not read as a
 * listing is treated as absent, so a picker draws the shipped list rather than half a file.
 */
export async function readModelCatalog(
  opts: UserDirEnv = {},
): Promise<ImageModelCatalog | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(userModelFile(opts)));
  } catch {
    return undefined;
  }
  const parsed = imageModelCatalog.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Writes the listing, replacing whatever was there. */
export async function writeModelCatalog(
  catalog: ImageModelCatalog,
  opts: UserDirEnv = {},
): Promise<void> {
  await ensureDir(userConfigDir(opts));
  await writeFileAtomic(userModelFile(opts), `${JSON.stringify(catalog, null, 2)}\n`);
}

/**
 * The listing as a price table: one `image` rate per model that states a per-picture price. It
 * is consulted after the author's table and the shipped one, so a figure either of those holds
 * wins over the listing's.
 */
export function catalogPriceTable(
  catalog: ImageModelCatalog | undefined,
): GenPriceTable | undefined {
  if (catalog === undefined) return undefined;
  const models: GenPriceModels = {};
  for (const entry of catalog.openrouter) {
    if (entry.priceUsd !== undefined) models[entry.id] = { image: entry.priceUsd };
  }
  return {
    name      : OPENROUTER_PRICES_NAME,
    pricesAsOf: catalog.asOf,
    source    : 'OpenRouter’s own model listing',
    models,
  };
}
