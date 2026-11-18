/**
 * The image seed and the shot's aspect ratio as authored fields: the narrowest rung wins, and a
 * project that authored none hashes exactly as it did before the fields existed.
 *
 * A project that authored neither must keep hashing the same because `params` is in the task
 * hash. A stray key here re-keys every task in every existing project and re-renders all of them.
 */
import { projectConfig, type ImageParams, type Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import {
  aspectFor,
  imageParams,
  locationInputs,
  modelFor,
  modelSheetInputs,
  portraitInputs,
  seedFor,
  shotInputs,
} from '../index.js';

const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'watercolor',
  models   : { vision: ['gemini', 'claude'] },
});

const base: ImageParams = imageParams(config);

function shotOf(seed?: number, aspect?: string): Shot {
  return {
    id         : 's1__a',
    sceneId    : 's1',
    framing    : 'medium',
    location   : 'day',
    subjects   : [{ characterId: 'aiko' }],
    coversLines: [],
    ...(seed === undefined ? {} : { seed }),
    ...(aspect === undefined ? {} : { aspect }),
  };
}

describe('aspectFor', () => {
  it('puts the shot’s own ratio in place of the project’s', () => {
    expect(aspectFor(base, shotOf(undefined, '3:4'))).toEqual({ ...base, aspect: '3:4' });
  });

  it('returns the very same params when the shot authored none', () => {
    // Identity rather than equality, for the reason `seedFor` checks it: a fresh object with the
    // same fields is where an `aspect: undefined` key gets into the inputs.
    expect(aspectFor(base, shotOf())).toBe(base);
    expect(aspectFor(base, {})).toBe(base);
  });
});

describe('seedFor', () => {
  it('takes the narrowest rung that authored one', () => {
    expect(seedFor(base, 7, 9).seed).toBe(9);
    expect(seedFor(base, 7, undefined).seed).toBe(7);
    expect(seedFor(base, undefined, 9).seed).toBe(9);
  });

  it('treats 0 as a seed like any other, not as "none"', () => {
    expect(seedFor(base, 7, 0).seed).toBe(0);
    expect(seedFor({ ...base, seed: 5 }, 0).seed).toBe(0);
  });

  it('returns the very same params when no rung authored one', () => {
    // The check is identity rather than equality. A fresh object with the same fields would hash
    // the same, but building one is the mistake that puts a `seed: undefined` key in the inputs.
    expect(seedFor(base)).toBe(base);
    expect(seedFor(base, undefined, undefined)).toBe(base);
  });
});

describe('modelFor', () => {
  it('takes the narrowest rung that authored one, and reads an empty string as none', () => {
    expect(modelFor(base, 'a', 'b').modelId).toBe('b');
    expect(modelFor(base, 'a', undefined).modelId).toBe('a');
    expect(modelFor(base, 'a', '').modelId).toBe('a');
    expect(modelFor(base, undefined, 'b').modelId).toBe('b');
  });

  it('returns the very same params when no rung authored one', () => {
    expect(modelFor(base)).toBe(base);
    expect(modelFor(base, undefined, '')).toBe(base);
  });
});

describe('the four builders', () => {
  const aiko = character('aiko', 'approved', 'sha-portrait');
  const cafe = location('cafe');

  it('leaves params untouched when nothing authored a seed', () => {
    const m = model([aiko], [scene('s1', ['aiko'], 'cafe')], [cafe]);
    const s = m.scenes.get('s1')!;
    expect(portraitInputs(aiko, config, base).params).toBe(base);
    expect(locationInputs(cafe, 'day', config, base).params).toBe(base);
    expect(
      modelSheetInputs(aiko, 'default', 'front', { hash: 'sha-portrait', ext: 'png' }, config, base)
        .params,
    ).toBe(base);
    expect(shotInputs(shotOf(), s, m, config, base, []).params).toBe(base);
  });

  it('reads a character seed for the portrait and an outfit seed for the sheet', () => {
    const c = {
      ...aiko,
      seed   : 4,
      outfits: [{ id: 'default', characterId: 'aiko', description: '', seed: 11 }],
    };
    // A portrait wears no outfit, so it stops at the character rung; a sheet reads the outfit rung.
    expect(portraitInputs(c, config, base).params.seed).toBe(4);
    expect(
      modelSheetInputs(c, 'default', 'front', { hash: 'sha-portrait', ext: 'png' }, config, base)
        .params.seed,
    ).toBe(11);
  });

  it('reads a variant seed for a plate, and the location seed for a variant that authored none', () => {
    const l = {
      ...cafe,
      seed    : 2,
      variants: [
        { id: 'day', description: '' },
        { id: 'night', description: '', seed: 8 },
      ],
    };
    expect(locationInputs(l, 'day', config, base).params.seed).toBe(2);
    expect(locationInputs(l, 'night', config, base).params.seed).toBe(8);
  });

  it('reads a shot seed, and nothing from the cast it draws', () => {
    const c = { ...aiko, seed: 4 };
    const m = model([c], [scene('s1', ['aiko'], 'cafe')], [cafe]);
    const s = m.scenes.get('s1')!;
    expect(shotInputs(shotOf(6), s, m, config, base, []).params.seed).toBe(6);
    expect(shotInputs(shotOf(), s, m, config, base, []).params).toBe(base);
  });

  it('reads the image model off the same rungs as the seed', () => {
    const c = {
      ...aiko,
      imageModel: 'char-model',
      outfits: [
        { id: 'default', characterId: 'aiko', description: '', imageModel: 'outfit-model' },
      ],
    };
    const l = {
      ...cafe,
      imageModel: 'loc-model',
      variants: [
        { id: 'day', description: '' },
        { id: 'night', description: '', imageModel: 'night-model' },
      ],
    };
    const m = model([c], [scene('s1', ['aiko'], 'cafe')], [l]);
    const s = m.scenes.get('s1')!;
    expect(portraitInputs(c, config, base).params.modelId).toBe('char-model');
    expect(
      modelSheetInputs(c, 'default', 'front', { hash: 'sha-portrait', ext: 'png' }, config, base)
        .params.modelId,
    ).toBe('outfit-model');
    expect(locationInputs(l, 'day', config, base).params.modelId).toBe('loc-model');
    expect(locationInputs(l, 'night', config, base).params.modelId).toBe('night-model');
    expect(
      shotInputs({ ...shotOf(), imageModel: 'shot-model' }, s, m, config, base, []).params.modelId,
    ).toBe('shot-model');
    expect(shotInputs(shotOf(), s, m, config, base, []).params).toBe(base);
  });

  it('reads a shot aspect beside its seed, and keeps the project’s where it authored none', () => {
    const m = model([aiko], [scene('s1', ['aiko'], 'cafe')], [cafe]);
    const s = m.scenes.get('s1')!;
    expect(shotInputs(shotOf(6, '9:16'), s, m, config, base, []).params).toEqual({
      ...base,
      seed  : 6,
      aspect: '9:16',
    });
    expect(shotInputs(shotOf(undefined, '9:16'), s, m, config, base, []).params).toEqual({
      ...base,
      aspect: '9:16',
    });
    expect(shotInputs(shotOf(6), s, m, config, base, []).params.aspect).toBe(base.aspect);
  });
});
