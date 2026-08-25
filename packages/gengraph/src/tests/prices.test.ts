import {
  PRICES_STALE_DAYS,
  SHIPPED_PRICES,
  mtok,
  priceEstimate,
  pricesAgeDays,
  pricesAreStale,
} from '../index.js';
import type { GenCostLine, GenPriceTable } from '../index.js';

const IMAGES: GenCostLine = {
  service: 'image',
  model: 'gemini-2.5-flash-image',
  unit: 'image',
  count: 10,
};

const UNKNOWN: GenCostLine = {
  service: 'text',
  model: 'no-such-model',
  unit: 'mtok-in',
  count: 1,
};

const USER_TABLE: GenPriceTable = {
  pricesAsOf: '2026-08-01',
  models: { 'gemini-2.5-flash-image': { image: 0.02 }, 'no-such-model': { 'mtok-in': 7 } },
};

describe('the shipped price table', () => {
  it('carries the day it was refreshed', () => {
    expect(SHIPPED_PRICES.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('prices the image model this repository configures by default', () => {
    expect(SHIPPED_PRICES.models['gemini-2.5-flash-image']?.image).toBeGreaterThan(0);
  });
});

describe('pricing an estimate', () => {
  it('turns counts into dollars', () => {
    const priced = priceEstimate([IMAGES]);
    const rate = SHIPPED_PRICES.models['gemini-2.5-flash-image']?.image ?? 0;

    expect(priced.usd).toBeCloseTo(rate * 10, 10);
    expect(priced.unpriced).toEqual([]);
    expect(priced.pricesAsOf).toBe(SHIPPED_PRICES.pricesAsOf);
  });

  it('names a model no table covers rather than counting it as free', () => {
    const priced = priceEstimate([IMAGES, UNKNOWN]);

    expect(priced.unpriced).toEqual([UNKNOWN]);
    expect(priced.lines[1]?.usd).toBeUndefined();
    expect(priced.usd).toBeCloseTo(
      (SHIPPED_PRICES.models['gemini-2.5-flash-image']?.image ?? 0) * 10,
      10,
    );
  });

  it('lets the first table given win over the shipped one', () => {
    const priced = priceEstimate([IMAGES, UNKNOWN], [USER_TABLE, SHIPPED_PRICES]);

    expect(priced.usd).toBeCloseTo(0.2 + 7, 10);
    expect(priced.unpriced).toEqual([]);
  });

  it('reports the oldest date among the tables it read', () => {
    const priced = priceEstimate([IMAGES, UNKNOWN], [USER_TABLE, SHIPPED_PRICES]);

    expect(priced.pricesAsOf).toBe('2026-08-01');
  });

  it('adds up nothing for an empty estimate', () => {
    expect(priceEstimate([])).toEqual({ lines: [], usd: 0, unpriced: [], pricesAsOf: undefined });
  });
});

describe('how old a price table is', () => {
  const now = new Date('2026-08-25T12:00:00Z');

  it('counts whole days since the stamp', () => {
    expect(pricesAgeDays('2026-08-15', now)).toBe(10);
  });

  it('calls a table older than the limit stale', () => {
    expect(pricesAreStale('2026-01-01', now)).toBe(true);
    expect(pricesAreStale('2026-08-15', now)).toBe(false);
  });

  it('takes the limit from the caller', () => {
    expect(pricesAreStale('2026-08-15', now, 5)).toBe(true);
  });

  it('calls a stamp it cannot read stale', () => {
    expect(pricesAgeDays('not a date', now)).toBeNaN();
    expect(pricesAreStale('not a date', now)).toBe(true);
  });

  it('leaves the limit at a quarter of a year', () => {
    expect(PRICES_STALE_DAYS).toBe(90);
  });
});

describe('counting tokens', () => {
  it('reads a token count as millions of tokens', () => {
    expect(mtok(1_500)).toBeCloseTo(0.0015, 10);
  });
});
