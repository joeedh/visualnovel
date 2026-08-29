/**
 * Asset → the rung that owns its prompt (`docs/plans/archive/INDEX.md#chunked-prompts` §2), and what that rung
 * says today. There is no merge chain; each asset gets one answer from a single lookup.
 */
import type { Asset, AssetKind, PromptOverride, Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { overrideAt, overrideOf, rungOf } from '../index.js';

function asset(kind: AssetKind, satisfies: Asset['satisfies']): Asset {
  return {
    hash: 'h',
    ext: 'png',
    kind,
    sourceTask: 't',
    refs: [],
    modelId: 'm',
    accepted: false,
    satisfies,
  };
}

const MUTE: PromptOverride = { mode: 'chunks', mute: ['palette'] };

describe('rungOf', () => {
  it('maps each planned kind to the rung that names one whole picture', () => {
    expect(rungOf(asset('portrait', [{ characterId: 'aiko' }]))).toEqual({
      kind: 'character',
      characterId: 'aiko',
    });
    expect(rungOf(asset('model_sheet', [{ characterId: 'aiko', outfit: 'gala' }]))).toEqual({
      kind: 'outfit',
      characterId: 'aiko',
      outfit: 'gala',
    });
    expect(rungOf(asset('location_ref', [{ locationId: 'cafe', variant: 'night' }]))).toEqual({
      kind: 'variant',
      locationId: 'cafe',
      variant: 'night',
    });
    expect(rungOf(asset('shot_image', [{ sceneId: 's1', shotId: 's1__a' }]))).toEqual({
      kind: 'shot',
      sceneId: 's1',
      shotId: 's1__a',
    });
  });

  it('gives a concept no rung — its prompt was authored, not derived', () => {
    expect(rungOf(asset('concept', [{ locationId: 'cafe' }]))).toBeUndefined();
  });

  it('gives nothing for an asset whose binding cannot name a rung', () => {
    expect(rungOf(asset('portrait', []))).toBeUndefined();
    // A sheet's rung is the outfit entry, so a sheet with no outfit has nowhere to write.
    expect(rungOf(asset('model_sheet', [{ characterId: 'aiko' }]))).toBeUndefined();
  });
});

describe('overrideAt', () => {
  const c = character('aiko');
  c.promptOverride = MUTE;
  c.outfits = [
    { id: 'default', characterId: 'aiko', description: '' },
    { id: 'gala', characterId: 'aiko', description: 'navy dress', promptOverride: MUTE },
  ];
  const l = location('cafe');
  l.variants = [
    { id: 'day', description: '' },
    { id: 'night', description: '', promptOverride: MUTE },
  ];
  const sc = scene('s1', ['aiko'], 'cafe');
  const shot: Shot = {
    id: 's1__a',
    sceneId: 's1',
    framing: 'medium',
    location: 'day',
    subjects: [],
    coversLines: [],
    status: 'pending',
    promptOverride: MUTE,
  };
  const ctx = { model: model([c], [sc], [l]), shots: new Map([['s1', [shot]]]) };

  it('reads each rung, and nothing where none is written', () => {
    expect(overrideAt({ kind: 'character', characterId: 'aiko' }, ctx)).toEqual(MUTE);
    expect(overrideAt({ kind: 'outfit', characterId: 'aiko', outfit: 'gala' }, ctx)).toEqual(MUTE);
    expect(
      overrideAt({ kind: 'outfit', characterId: 'aiko', outfit: 'default' }, ctx),
    ).toBeUndefined();
    expect(overrideAt({ kind: 'variant', locationId: 'cafe', variant: 'night' }, ctx)).toEqual(
      MUTE,
    );
    expect(
      overrideAt({ kind: 'variant', locationId: 'cafe', variant: 'day' }, ctx),
    ).toBeUndefined();
    expect(overrideAt({ kind: 'shot', sceneId: 's1', shotId: 's1__a' }, ctx)).toEqual(MUTE);
  });

  it('answers nothing for a rung the project no longer has', () => {
    expect(overrideAt({ kind: 'character', characterId: 'gone' }, ctx)).toBeUndefined();
    expect(overrideAt({ kind: 'shot', sceneId: 's9', shotId: 'x' }, ctx)).toBeUndefined();
    // With no storyboards loaded the answer is unknown, which has the same shape as "not
    // overridden".
    expect(
      overrideAt({ kind: 'shot', sceneId: 's1', shotId: 's1__a' }, { model: ctx.model }),
    ).toBeUndefined();
  });

  it('goes from an asset to its override in one call', () => {
    expect(overrideOf(asset('shot_image', [{ sceneId: 's1', shotId: 's1__a' }]), ctx)).toEqual(
      MUTE,
    );
    expect(overrideOf(asset('concept', [{ locationId: 'cafe' }]), ctx)).toBeUndefined();
  });
});
