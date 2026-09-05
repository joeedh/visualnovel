/**
 * Stores the author's own price table and refreshes it. The table is scoped per-user rather
 * than per-project, because what a vendor charges is the same in every project on the machine,
 * and a figure looked up once should not have to be looked up again in the next one.
 */
import { userConfigDir } from '@vn/config';
import type { UserDirEnv } from '@vn/config';
import { ensureDir, join, readText, writeFileAtomic } from '@vn/util';
import { z } from 'zod';

import { pluginPriceTable } from './manifest.js';
import { genPriceAgent, parseGenPriceModels } from './priceagent.js';
import { genPriceModels, USER_PRICES_NAME } from './prices.js';
import type { GenPriceModels, GenPriceTable } from './prices.js';
import { readInstalledPlugins } from './pluginload.js';
import type { GenServices } from './services.js';

const userTable = z.object({
  pricesAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source    : z.string().optional(),
  models    : genPriceModels,
});

/** Where the author's table is kept, beside their keys and the plugins they installed. */
export function userPriceFile(opts: UserDirEnv = {}): string {
  return join(userConfigDir(opts), 'prices.json');
}

/**
 * The author's table, or nothing when they have never refreshed one. A file that does not
 * read as a table is treated as absent, because an estimate priced from a half-parsed table
 * is worse than one that says a model has no price.
 */
export async function readUserPrices(opts: UserDirEnv = {}): Promise<GenPriceTable | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(userPriceFile(opts)));
  } catch {
    return undefined;
  }

  const parsed = userTable.safeParse(raw);
  if (!parsed.success) return undefined;
  return { name: USER_PRICES_NAME, ...parsed.data };
}

/** Writes the author's table, replacing whatever was there. */
export async function writeUserPrices(table: GenPriceTable, opts: UserDirEnv = {}): Promise<void> {
  const file = userPriceFile(opts);
  await ensureDir(userConfigDir(opts));
  const { pricesAsOf, source, models } = table;
  await writeFileAtomic(file, `${JSON.stringify({ pricesAsOf, source, models }, null, 2)}\n`);
}

export type GenPriceRefresh =
  { ok: true; table: GenPriceTable; models: string[] } | { ok: false; reason: string };

/**
 * Runs one plugin's price agent and folds what it answers into the author's table. The models
 * the agent did not mention are left as they were, so refreshing one plugin does not discard
 * what another one found. Nothing here asks the author anything: a refresh spends money on
 * their key, so the host has already asked by the time this runs.
 */
export async function refreshUserPrices(
  plugin: string,
  services: GenServices,
  now: Date,
  opts: UserDirEnv = {},
): Promise<GenPriceRefresh> {
  const agent = genPriceAgent(plugin);
  if (agent === undefined) {
    return { ok: false, reason: `${plugin} has no price agent, or it is not loaded` };
  }

  let answered: unknown;
  try {
    answered = await agent(services);
  } catch (err) {
    return { ok: false, reason: `${plugin}'s price agent failed: ${String(err)}` };
  }

  const parsed = parseGenPriceModels(answered);
  if (!parsed.ok)
    return { ok: false, reason: `${plugin} answered with prices that ${parsed.reason}` };

  const before = await readUserPrices(opts);
  const models: GenPriceModels = { ...before?.models, ...parsed.models };
  const table: GenPriceTable = {
    name      : USER_PRICES_NAME,
    pricesAsOf: now.toISOString().slice(0, 10),
    source    : 'looked up by a plugin on your own key',
    models,
  };
  await writeUserPrices(table, opts);
  return { ok: true, table, models: Object.keys(parsed.models).sort() };
}

/**
 * The tables installed plugins declare, in name order. A plugin that declares no prices
 * contributes none, and one whose directory does not read as a plugin is skipped rather than
 * reported, because a refusal belongs to the load that reads it.
 */
export async function installedPriceTables(opts: UserDirEnv = {}): Promise<GenPriceTable[]> {
  const out: GenPriceTable[] = [];
  for (const read of await readInstalledPlugins(opts)) {
    const table = read.manifest === undefined ? undefined : pluginPriceTable(read.manifest);
    if (table !== undefined) out.push(table);
  }
  return out;
}
