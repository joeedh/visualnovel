import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ImageModelCatalog } from '@vn/types';

import {
  catalogPriceTable,
  OPENROUTER_PRICES_NAME,
  readModelCatalog,
  userModelFile,
  writeModelCatalog,
} from '../modelstore.js';
import { genPriceTables, priceEstimate, SHIPPED_PRICES } from '../prices.js';

let home = '';

/** The user directory every call in this file reads and writes under. */
function env(): { env: { VNAUTHOR_HOME: string } } {
  return { env: { VNAUTHOR_HOME: home } };
}

const CATALOG: ImageModelCatalog = {
  asOf      : '2026-09-15',
  openrouter: [
    { id: 'openai/gpt-image-2', name: 'GPT Image 2', aspects: ['1:1'], seed: false },
    {
      id      : 'bytedance-seed/seedream-4.5',
      name    : 'Seedream 4.5',
      aspects : ['1:1', '16:9'],
      seed    : true,
      priceUsd: 0.04,
    },
  ],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gengraph-models-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('readModelCatalog', () => {
  it('answers nothing with no file', async () => {
    expect(await readModelCatalog(env())).toBeUndefined();
  });

  it('reads back what writeModelCatalog wrote', async () => {
    await writeModelCatalog(CATALOG, env());
    expect(userModelFile(env())).toBe(join(home, 'models.json'));
    expect(await readModelCatalog(env())).toEqual(CATALOG);
  });

  it('treats a file of the wrong shape as absent', async () => {
    writeFileSync(userModelFile(env()), JSON.stringify({ asOf: 'yesterday', openrouter: [] }));
    expect(await readModelCatalog(env())).toBeUndefined();
    writeFileSync(userModelFile(env()), '{not json');
    expect(await readModelCatalog(env())).toBeUndefined();
  });
});

describe('catalogPriceTable', () => {
  it('prices the models that state a per-picture price, dated by the listing', () => {
    expect(catalogPriceTable(CATALOG)).toEqual({
      name      : OPENROUTER_PRICES_NAME,
      pricesAsOf: '2026-09-15',
      source    : 'OpenRouter’s own model listing',
      models    : { 'bytedance-seed/seedream-4.5': { image: 0.04 } },
    });
    expect(catalogPriceTable(undefined)).toBeUndefined();
  });

  it('is consulted after the author’s table, so a figure there wins', () => {
    const user = {
      name      : 'yours',
      pricesAsOf: '2026-09-01',
      models    : { 'bytedance-seed/seedream-4.5': { image: 0.01 } },
    };
    const tables = genPriceTables({ user, plugins: [catalogPriceTable(CATALOG)!] });
    const estimate = priceEstimate(
      [
        { service: 'image', model: 'bytedance-seed/seedream-4.5', unit: 'image', count: 1 },
        { service: 'image', model: 'openai/gpt-image-2', unit: 'image', count: 1 },
      ],
      tables,
    );
    expect(tables[1]).toBe(SHIPPED_PRICES);
    expect(estimate.usd).toBe(0.01);
    expect(estimate.lines[0]?.table).toBe('yours');
    expect(estimate.unpriced.map((line) => line.model)).toEqual(['openai/gpt-image-2']);
  });
});
