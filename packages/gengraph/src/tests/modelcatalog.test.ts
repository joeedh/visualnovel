import {
  imageModelChoices,
  inheritLabel,
  modelCatalog,
  openRouterTooltip,
  setModelCatalog,
  shippedImageModels,
  type ModelCatalog,
} from '../modelcatalog.js';
import { SHIPPED_PRICES } from '../prices.js';

const CATALOG: ModelCatalog = {
  shipped   : ['gemini-2.5-flash-image'],
  openrouter: [
    { id: 'openai/gpt-image-2', name: 'GPT Image 2', aspects: ['1:1', '16:9'], seed: false },
    { id: 'google/gemini-3-pro-image', name: 'Gemini 3 Pro Image', aspects: [], seed: false },
    {
      id      : 'bytedance-seed/seedream-4.5',
      name    : 'Seedream 4.5',
      aspects : ['1:1'],
      seed    : true,
      priceUsd: 0.04,
    },
  ],
  default   : 'openai/gpt-image-2',
  asOf      : '2026-09-15',
};

afterEach(() => setModelCatalog(undefined));

describe('shippedImageModels', () => {
  it('lists the ids the shipped table prices per image', () => {
    const listed = shippedImageModels();
    expect(listed).toContain('gemini-2.5-flash-image');
    for (const id of listed) expect(SHIPPED_PRICES.models[id]?.image).toBeDefined();
  });
});

describe('the snapshot', () => {
  it('is nothing until set, and what was set afterwards', () => {
    expect(modelCatalog()).toBeUndefined();
    setModelCatalog(CATALOG);
    expect(modelCatalog()).toBe(CATALOG);
  });
});

describe('imageModelChoices', () => {
  it('lists the shipped ids and the current value with no catalog', () => {
    expect(imageModelChoices(undefined, 'gemini-2.5-flash-image').map((row) => row.id)).toEqual(
      shippedImageModels(),
    );
    const rows = imageModelChoices(undefined, 'openai/gpt-image-2');
    expect(rows.map((row) => row.id)).toEqual([...shippedImageModels(), 'openai/gpt-image-2']);
    expect(rows.at(-1)?.tooltip).toContain('not in the cached listing');
  });

  it('orders the inherit row, the shipped ids, the listing, then a current value in none of them', () => {
    const rows = imageModelChoices(CATALOG, 'recraft/recraft-v4', { inherit: true });
    expect(rows.map((row) => row.id)).toEqual([
      '',
      'gemini-2.5-flash-image',
      'openai/gpt-image-2',
      'google/gemini-3-pro-image',
      'bytedance-seed/seedream-4.5',
      'recraft/recraft-v4',
    ]);
    expect(rows[0]?.label).toBe('Inherit (openai/gpt-image-2)');
    expect(rows[2]?.label).toBe('openai/gpt-image-2');
    expect(imageModelChoices(CATALOG, 'openai/gpt-image-2').map((row) => row.id)).toEqual([
      'gemini-2.5-flash-image',
      'openai/gpt-image-2',
      'google/gemini-3-pro-image',
      'bytedance-seed/seedream-4.5',
    ]);
  });

  it('says on each row how it draws: the vendor, the price, the ratios, the seed', () => {
    const rows = imageModelChoices(CATALOG, '');
    expect(rows[0]?.tooltip).toBe('Draw with gemini-2.5-flash-image, through Gemini.');
    expect(rows[1]?.tooltip).toBe(
      'GPT Image 2: no per-picture price listed; 1:1 16:9; no seed; routed by OpenRouter; not zero-data-retention.',
    );
    expect(rows[2]?.tooltip).toBe(
      'Gemini 3 Pro Image: no per-picture price listed; no aspect ratios declared; no seed; routed by OpenRouter.',
    );
    expect(rows[3]?.tooltip).toBe(
      'Seedream 4.5: about $0.040 per picture; 1:1; takes a seed; routed by OpenRouter; not zero-data-retention.',
    );
    expect(openRouterTooltip(CATALOG.openrouter[2]!)).toBe(rows[3]?.tooltip);
  });

  it('names the project model in the inherit row only once a catalog says it', () => {
    expect(inheritLabel(undefined)).toBe('Inherit (project image model)');
    expect(inheritLabel({ ...CATALOG, default: '' })).toBe('Inherit (project image model)');
    expect(inheritLabel(CATALOG)).toBe('Inherit (openai/gpt-image-2)');
  });
});
