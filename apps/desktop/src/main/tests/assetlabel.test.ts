import type { AnyTask, Asset, ProjectModel } from '@vn/types';
import { assetLabel, labelAssets, labelContext, type AssetLabelContext } from '../assetlabel.js';

const model = {
  characters: new Map([['aiko', { id: 'aiko', name: 'Aiko' }]]),
  locations: new Map([['cafe', { id: 'cafe', name: 'Café Mori' }]]),
} as unknown as ProjectModel;

const asset = (over: Partial<Asset> = {}): Asset => ({
  hash: 'a'.repeat(64),
  ext: 'png',
  kind: 'portrait',
  sourceTask: 't1',
  refs: [],
  modelId: 'm',
  satisfies: [{ characterId: 'aiko' }],
  accepted: false,
  ...over,
});

const ctx: AssetLabelContext = { model, angleOf: (t) => (t === 't1' ? 'front' : undefined) };

describe('assetLabel', () => {
  it('names a portrait by the character', () => {
    expect(assetLabel(asset(), ctx)).toBe('Aiko');
  });

  it('names a model sheet by character, outfit and the angle only the task knows', () => {
    const sheet = asset({
      kind: 'model_sheet',
      satisfies: [{ characterId: 'aiko', outfit: 'uniform' }],
    });
    expect(assetLabel(sheet, ctx)).toBe('Aiko — uniform / front');
  });

  it('names a location plate by location and variant', () => {
    const plate = asset({
      kind: 'location_ref',
      satisfies: [{ locationId: 'cafe', variant: 'night' }],
    });
    expect(assetLabel(plate, ctx)).toBe('Café Mori — night');
  });

  it('names a shot frame the way the tree already names scenes and shots', () => {
    const frame = asset({ kind: 'shot_image', satisfies: [{ sceneId: 'greet', shotId: 's2' }] });
    expect(assetLabel(frame, ctx)).toBe('greet · s2');
  });

  it('names a concept by its subject and the sentence it was asked for', () => {
    const concept = asset({
      kind: 'concept',
      satisfies: [{ locationId: 'cafe' }],
      title: 'aerial shot of the roof',
    });
    expect(assetLabel(concept, ctx)).toBe('Café Mori — aerial shot of the roof');
  });

  it('names an unbound concept by the sentence alone', () => {
    const concept = asset({ kind: 'concept', satisfies: [], title: 'a rain-slick alley' });
    expect(assetLabel(concept, ctx)).toBe('a rain-slick alley');
  });

  it('has no name for an asset nothing in the model claims', () => {
    expect(assetLabel(asset({ satisfies: [] }), ctx)).toBeUndefined();
    expect(assetLabel(asset({ satisfies: [{ characterId: 'gone' }] }), ctx)).toBeUndefined();
  });
});

describe('labelAssets', () => {
  it('falls back to hash8.ext when there is no name to give', () => {
    const orphan = asset({ hash: 'f'.repeat(64), satisfies: [] });
    expect(labelAssets([orphan], ctx).get(orphan.hash)).toBe('ffffffff.png');
  });

  it('suffixes both sides of a collision, so a label is never quietly ambiguous', () => {
    const one = asset({ hash: `1${'0'.repeat(63)}` });
    const two = asset({ hash: `2${'0'.repeat(63)}` });
    const labels = labelAssets([one, two], ctx);
    expect(labels.get(one.hash)).toBe('Aiko (10000000)');
    expect(labels.get(two.hash)).toBe('Aiko (20000000)');
  });

  it('leaves a unique label unsuffixed', () => {
    const one = asset();
    expect(labelAssets([one], ctx).get(one.hash)).toBe('Aiko');
  });
});

describe('labelContext', () => {
  it('reads the angle off the source task, which is the only place it exists', () => {
    const task = { hash: 't1', kind: 'model_sheet', inputs: { angle: 'three_quarter' } } as AnyTask;
    const graph = { get: (h: string) => (h === 't1' ? task : undefined) };
    const sheet = asset({
      kind: 'model_sheet',
      satisfies: [{ characterId: 'aiko', outfit: 'gala' }],
    });
    expect(assetLabel(sheet, labelContext(model, graph))).toBe('Aiko — gala / three_quarter');
  });
});
