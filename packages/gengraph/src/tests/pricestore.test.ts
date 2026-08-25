import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as esbuild from 'esbuild';

import { mockServices } from '../nodes/tests/__fixtures__/services.js';
import { activateGenPlugin, esbuildPluginBundler, userPluginsDir } from '../pluginload.js';
import { genPriceTables, priceEstimate, SHIPPED_PRICES, USER_PRICES_NAME } from '../prices.js';
import type { GenPriceTable } from '../prices.js';
import {
  installedPriceTables,
  readUserPrices,
  refreshUserPrices,
  userPriceFile,
  writeUserPrices,
} from '../pricestore.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const FIXTURE = join(REPO_ROOT, 'packages', 'testkit', 'src', 'plugin');

const bundle = esbuildPluginBundler(esbuild);

const NOW = new Date('2026-08-25T12:00:00Z');

let home = '';

/** The user directory every call in this file reads and writes under. */
function env(): { env: { VNAUTHOR_HOME: string } } {
  return { env: { VNAUTHOR_HOME: home } };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gengraph-prices-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The fixture plugin copied where a real install would put it, with `over` merged in. */
function install(name = 'testkit-shout', over: Record<string, unknown> = {}): string {
  const dir = join(userPluginsDir(env()), name);
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...manifest, name, ...over }, null, 2));
  return dir;
}

describe('which table prices a line', () => {
  const yours: GenPriceTable = {
    name: USER_PRICES_NAME,
    pricesAsOf: '2026-08-01',
    models: { 'mock-image': { image: 0.5 } },
  };
  const theirs: GenPriceTable = {
    name: 'acme',
    pricesAsOf: '2026-07-01',
    models: { 'mock-image': { image: 9 }, 'acme-draw': { image: 2 } },
  };

  it('reads the author’s table first and the shipped one before a plugin’s', () => {
    expect(genPriceTables({ user: yours, plugins: [theirs] }).map((t) => t.name)).toEqual([
      USER_PRICES_NAME,
      SHIPPED_PRICES.name,
      'acme',
    ]);
  });

  it('names the table each line was priced from', () => {
    const estimate = priceEstimate(
      [
        { service: 'image', model: 'mock-image', unit: 'image', count: 2 },
        { service: 'image', model: 'acme-draw', unit: 'image', count: 1 },
        { service: 'image', model: 'nobody-prices-this', unit: 'image', count: 1 },
      ],
      genPriceTables({ user: yours, plugins: [theirs] }),
    );

    expect(estimate.lines.map((l) => l.table)).toEqual([USER_PRICES_NAME, 'acme', undefined]);
    expect(estimate.usd).toBeCloseTo(3);
    expect(estimate.unpriced.map((l) => l.model)).toEqual(['nobody-prices-this']);
    // The oldest table that priced anything, so a stale figure is not hidden by a fresh one.
    expect(estimate.pricesAsOf).toBe('2026-07-01');
  });
});

describe('the author’s own table', () => {
  it('has none until one is written, and reads back what was written', async () => {
    expect(await readUserPrices(env())).toBeUndefined();

    await writeUserPrices(
      {
        name: USER_PRICES_NAME,
        pricesAsOf: '2026-08-25',
        source: 'typed in by hand',
        models: { 'acme-draw': { image: 1 } },
      },
      env(),
    );

    expect(await readUserPrices(env())).toEqual({
      name: USER_PRICES_NAME,
      pricesAsOf: '2026-08-25',
      source: 'typed in by hand',
      models: { 'acme-draw': { image: 1 } },
    });
  });

  it('treats a file that does not read as a table as no table at all', async () => {
    writeFileSync(userPriceFile(env()), '{"models":{"acme":{"image":"free"}}}');
    expect(await readUserPrices(env())).toBeUndefined();
  });
});

describe('refreshing prices from a plugin', () => {
  it('refuses a plugin that registered no price agent', async () => {
    const refresh = await refreshUserPrices('nobody', mockServices(), NOW, env());
    expect(refresh).toEqual({
      ok: false,
      reason: 'nobody has no price agent, or it is not loaded',
    });
  });

  it('writes what the agent answered, keeping what another refresh found', async () => {
    await writeUserPrices(
      { name: USER_PRICES_NAME, pricesAsOf: '2026-01-01', models: { 'acme-draw': { image: 1 } } },
      env(),
    );
    await activateGenPlugin(install(), bundle);

    const services = mockServices({
      reply: JSON.stringify({ 'testkit-shouter': { 'mtok-in': 1.5, 'mtok-out': 3 } }),
    });
    const refresh = await refreshUserPrices('testkit-shout', services, NOW, env());

    expect(refresh).toMatchObject({ ok: true, models: ['testkit-shouter'] });
    expect(services.texts).toHaveLength(1);
    expect(await readUserPrices(env())).toEqual({
      name: USER_PRICES_NAME,
      pricesAsOf: '2026-08-25',
      source: 'looked up by a plugin on your own key',
      models: { 'acme-draw': { image: 1 }, 'testkit-shouter': { 'mtok-in': 1.5, 'mtok-out': 3 } },
    });
  }, 60_000);

  it('refuses an answer that prices nothing, leaving the table alone', async () => {
    await activateGenPlugin(install(), bundle);

    const refresh = await refreshUserPrices(
      'testkit-shout',
      mockServices({ reply: '{"testkit-shouter":{}}' }),
      NOW,
      env(),
    );

    expect(refresh).toMatchObject({ ok: false });
    if (!refresh.ok) expect(refresh.reason).toContain('no unit is priced for testkit-shouter');
    expect(existsSync(userPriceFile(env()))).toBe(false);
  }, 60_000);
});

describe('the tables installed plugins declare', () => {
  it('reads a manifest’s own fragment, named after the plugin', async () => {
    install('acme', {
      prices: { pricesAsOf: '2026-08-01', models: { 'acme-draw': { image: 2 } } },
    });
    expect(await installedPriceTables(env())).toEqual([
      { name: 'acme', pricesAsOf: '2026-08-01', models: { 'acme-draw': { image: 2 } } },
    ]);
  });

  it('contributes nothing for a plugin that declares no prices', async () => {
    install('quiet', { prices: undefined });
    expect(await installedPriceTables(env())).toEqual([]);
  });
});
