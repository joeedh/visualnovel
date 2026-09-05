/**
 * The price agents plugins register, and the map a host looks one up in. An agent runs only
 * when the author asks for a refresh: it spends money on their own key, and a price nobody
 * asked for is not worth a model call.
 */
import { genPriceModels } from './prices.js';
import type { GenPriceModels } from './prices.js';
import type { GenServices } from './services.js';

/**
 * What a plugin answers a price refresh with. It reaches the network through the services it
 * was handed, so every request it makes is recorded in the host's ring like any other.
 */
export type GenPriceAgent = (services: GenServices) => Promise<GenPriceModels>;

const agents = new Map<string, GenPriceAgent>();

/** Records a plugin's price agent, replacing whatever that plugin registered before. */
export function registerGenPriceAgent(plugin: string, agent: GenPriceAgent): void {
  agents.set(plugin, agent);
}

export function genPriceAgent(plugin: string): GenPriceAgent | undefined {
  return agents.get(plugin);
}

/** The plugins that registered a price agent, in name order. */
export function genPriceAgents(): string[] {
  return [...agents.keys()].sort();
}

export type GenPriceModelsResult =
  { ok: true; models: GenPriceModels } | { ok: false; reason: string };

/**
 * Reads what an agent answered. A price agent's figures come from a model, so they are parsed
 * at this boundary the way every other machine-written value in this repository is, and a
 * malformed answer is named rather than written to the author's table.
 */
export function parseGenPriceModels(raw: unknown): GenPriceModelsResult {
  const parsed = genPriceModels.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.join('.') ?? '';
    return {
      ok    : false,
      reason: `the prices are not a price table: ${at} ${issue?.message ?? ''}`.trim(),
    };
  }

  const names = Object.keys(parsed.data);
  if (names.length === 0) {
    return { ok: false, reason: 'the prices name no model' };
  }

  const empty = names.filter((model) => Object.keys(parsed.data[model] ?? {}).length === 0);
  if (empty.length > 0) {
    return { ok: false, reason: `no unit is priced for ${empty.sort().join(', ')}` };
  }

  return { ok: true, models: parsed.data };
}
