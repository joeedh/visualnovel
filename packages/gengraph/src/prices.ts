import shipped from './prices.json';
import type { GenCostLine, GenCostUnit } from './registry.js';

/** Dollars per unit for the models one table knows about. */
export interface GenPriceTable {
  /** The day the prices were last refreshed, as `YYYY-MM-DD`. */
  pricesAsOf: string;
  /** Where the figures came from, for a reader deciding whether to trust them. */
  source?: string;
  models: Record<string, Partial<Record<GenCostUnit, number>>>;
}

/**
 * The table shipped with the app, refreshed at release. It covers the models this
 * repository configures by default and not every model a project can name, because a
 * figure nobody has checked is worse than an unpriced line. A model it omits prices as
 * {@link GenPricedLine} with no `usd`, and the user-level table fills the rest in.
 */
export const SHIPPED_PRICES: GenPriceTable = shipped;

/** How many days old a table may be before {@link pricesAreStale} calls it out. */
export const PRICES_STALE_DAYS = 90;

const MS_PER_DAY = 86_400_000;

export interface GenPricedLine extends GenCostLine {
  /** What the line costs. No table priced the model when this is absent. */
  usd?: number;
}

export interface GenPricedEstimate {
  lines: GenPricedLine[];
  /** What the priced lines add up to. An unpriced line contributes nothing to it. */
  usd: number;
  /** The lines no table priced, so a caller can name the models instead of showing zero. */
  unpriced: GenPricedLine[];
  /** The oldest `pricesAsOf` among the tables that supplied a price. */
  pricesAsOf?: string;
}

/**
 * Turns expected calls into dollars. The tables are consulted in order and the first one
 * holding the model's unit wins, so a caller passes the user's own table ahead of
 * {@link SHIPPED_PRICES}. A model no table covers is reported rather than counted as
 * free, which is what keeps a total from quietly shrinking as models are added.
 */
export function priceEstimate(
  lines: readonly GenCostLine[],
  tables: readonly GenPriceTable[] = [SHIPPED_PRICES],
): GenPricedEstimate {
  const priced: GenPricedLine[] = [];
  const unpriced: GenPricedLine[] = [];
  const dates: string[] = [];
  let usd = 0;

  for (const line of lines) {
    const table = tables.find((t) => t.models[line.model]?.[line.unit] !== undefined);
    const rate = table?.models[line.model]?.[line.unit];

    if (table === undefined || rate === undefined) {
      const out: GenPricedLine = { ...line };
      priced.push(out);
      unpriced.push(out);
      continue;
    }

    dates.push(table.pricesAsOf);
    usd += rate * line.count;
    priced.push({ ...line, usd: rate * line.count });
  }

  dates.sort();
  return { lines: priced, usd, unpriced, pricesAsOf: dates[0] };
}

/**
 * How many whole days lie between a table's date and the moment given. The clock is the
 * caller's, so nothing in this package reads it, which keeps every estimate reproducible.
 * A date that does not parse gives `NaN`.
 */
export function pricesAgeDays(pricesAsOf: string, now: Date): number {
  const then = Date.parse(`${pricesAsOf}T00:00:00Z`);
  if (Number.isNaN(then)) {
    return Number.NaN;
  }
  return Math.floor((now.getTime() - then) / MS_PER_DAY);
}

/**
 * True once a table is older than `staleAfterDays`. A date that does not parse counts as
 * stale, because an unreadable stamp is no evidence that the prices are current.
 */
export function pricesAreStale(
  pricesAsOf: string,
  now: Date,
  staleAfterDays: number = PRICES_STALE_DAYS,
): boolean {
  const age = pricesAgeDays(pricesAsOf, now);
  return Number.isNaN(age) || age > staleAfterDays;
}

/**
 * One sentence pricing a run. The desktop confirmation and the authoring agent's both quote
 * it, so an author reads the same figure whichever of the two asks them to approve the spend.
 */
export function estimateSentence(estimate: GenPricedEstimate, stale: boolean): string {
  const unpriced = new Set(estimate.unpriced.map((line) => line.model));
  const missing =
    unpriced.size === 0 ? '' : `, with no price for ${[...unpriced].sort().join(', ')}`;
  const age = stale ? ', from a price table over three months old' : '';
  return `About $${estimate.usd.toFixed(2)}${missing}${age}.`;
}

/** Millions of tokens, which is what a `mtok-in` or `mtok-out` count is measured in. */
export function mtok(tokens: number): number {
  return tokens / 1_000_000;
}
