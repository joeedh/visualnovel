/**
 * The image seed as an authored field: the narrowest rung wins, and a project that authored none
 * hashes exactly as it did before seeds existed.
 *
 * The second half is the one worth pinning — `params` is in the task hash, so a stray key here
 * re-keys every task in every existing project and re-renders the lot.
 */
import { projectConfig, type ImageParams, type Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import {
  imageParams,
  locationInputs,
  modelSheetInputs,
  portraitInputs,
  seedFor,
  shotInputs,
} from '../index.js';

const config = projectConfig.parse({
  title: 'Test',
  art_style: 'watercolor',
  models: { vision: ['gemini', 'claude'] },
});

const base: ImageParams = imageParams(config);

function shotOf(seed?: number): Shot {
  return {
    id: 's1__a',
    sceneId: 's1',
    framing: 'medium',
    location: 'day',
    subjects: [{ characterId: 'aiko' }],
    coversLines: [],
    status: 'pending',
    ...(seed === undefined ? {} : { seed }),
  };
}

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
    // Identity, not equality: a fresh object with the same fields would still hash the same, but
    // returning one at all is the mistake that would put a `seed: undefined` key in the inputs.
    expect(seedFor(base)).toBe(base);
    expect(seedFor(base, undefined, undefined)).toBe(base);
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
      seed: 4,
      outfits: [{ id: 'default', characterId: 'aiko', description: '', seed: 11 }],
    };
    // A portrait wears no outfit, so it stops at the character rung; a sheet does not.
    expect(portraitInputs(c, config, base).params.seed).toBe(4);
    expect(
      modelSheetInputs(c, 'default', 'front', { hash: 'sha-portrait', ext: 'png' }, config, base)
        .params.seed,
    ).toBe(11);
  });

  it('reads a variant seed for a plate, and the location seed for a variant that authored none', () => {
    const l = {
      ...cafe,
      seed: 2,
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
});
