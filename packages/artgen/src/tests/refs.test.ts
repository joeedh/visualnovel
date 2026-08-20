/**
 * A binding → what fills that slot today (`docs/plans/archive/chunked-prompts.md` §11). The pin is what
 * the model is fed; what a binding resolves to is only ever the comparison shown beside it.
 */
import type { Asset, AssetKind, ChunkRef } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { refDrift, resolveBinding, type BindingContext } from '../index.js';

function asset(
  hash: string,
  kind: AssetKind,
  satisfies: Asset['satisfies'],
  over: Partial<Asset> = {},
): Asset {
  return {
    hash,
    ext: 'png',
    kind,
    sourceTask: `task-${hash}`,
    refs: [],
    modelId: 'm',
    accepted: false,
    satisfies,
    ...over,
  };
}

const ASSETS: Asset[] = [
  asset('sheet-front', 'model_sheet', [{ characterId: 'aiko', outfit: 'uniform' }]),
  asset('sheet-side', 'model_sheet', [{ characterId: 'aiko', outfit: 'uniform' }]),
  asset('plate-night', 'location_ref', [{ locationId: 'cafe', variant: 'night' }]),
  asset('frame', 'shot_image', [{ sceneId: 'arrival', shotId: 'arrival__a' }]),
];

const ANGLES: Record<string, string> = { 'task-sheet-front': 'front', 'task-sheet-side': 'side' };

function ctx(assets: readonly Asset[] = ASSETS): BindingContext {
  const aiko = character('aiko', 'approved', 'portrait-hash');
  return {
    model: model([aiko], [scene('arrival', ['aiko'], 'cafe')], [location('cafe')]),
    assets,
    angleOf: (task) => (task ? ANGLES[task] : undefined),
  };
}

describe('resolveBinding', () => {
  it('answers each of the five kinds from the slot that owns it', () => {
    const c = ctx();
    expect(resolveBinding({ kind: 'portrait', characterId: 'aiko' }, c)).toBe('portrait-hash');
    expect(
      resolveBinding({ kind: 'sheet', characterId: 'aiko', outfit: 'uniform', angle: 'side' }, c),
    ).toBe('sheet-side');
    expect(resolveBinding({ kind: 'plate', locationId: 'cafe', variant: 'night' }, c)).toBe(
      'plate-night',
    );
    expect(resolveBinding({ kind: 'shot', sceneId: 'arrival', shotId: 'arrival__a' }, c)).toBe(
      'frame',
    );
    // An upload or a concept has no slot, so its own hash is the answer.
    expect(resolveBinding({ kind: 'asset', hash: 'uploaded' }, c)).toBe('uploaded');
  });

  it('gives nothing for a slot nothing fills', () => {
    const c = ctx();
    expect(resolveBinding({ kind: 'portrait', characterId: 'ren' }, c)).toBeUndefined();
    expect(
      resolveBinding({ kind: 'plate', locationId: 'cafe', variant: 'dawn' }, c),
    ).toBeUndefined();
    expect(
      resolveBinding({ kind: 'sheet', characterId: 'aiko', outfit: 'gala', angle: 'front' }, c),
    ).toBeUndefined();
  });

  it('declines rather than guesses when several assets serve one slot', () => {
    // Two sheets and no angle lookup to tell them apart. The manifest is hash-sorted, so picking
    // one would be picking arbitrarily.
    const blind: BindingContext = { ...ctx(), angleOf: undefined };
    expect(
      resolveBinding(
        { kind: 'sheet', characterId: 'aiko', outfit: 'uniform', angle: 'front' },
        blind,
      ),
    ).toBeUndefined();
  });

  it('lets acceptance settle a slot with several candidates', () => {
    const c = ctx([
      ...ASSETS,
      asset('plate-night-2', 'location_ref', [{ locationId: 'cafe', variant: 'night' }], {
        accepted: true,
      }),
    ]);
    expect(resolveBinding({ kind: 'plate', locationId: 'cafe', variant: 'night' }, c)).toBe(
      'plate-night-2',
    );
  });
});

describe('refDrift', () => {
  const ref = (over: Partial<ChunkRef>): ChunkRef => ({ pin: 'plate-night', ext: 'png', ...over });

  it('never drifts an unlinked reference — there is no slot to move', () => {
    expect(refDrift(ref({ pin: 'uploaded' }), ctx())).toBe(false);
  });

  it('is false while the slot still holds what was pinned', () => {
    const from = { kind: 'plate', locationId: 'cafe', variant: 'night' } as const;
    expect(refDrift(ref({ from }), ctx())).toBe(false);
  });

  it('is true once the slot holds something else', () => {
    const from = { kind: 'plate', locationId: 'cafe', variant: 'night' } as const;
    expect(refDrift(ref({ pin: 'plate-night-old', from }), ctx())).toBe(true);
  });

  it('makes no claim when the slot cannot be resolved at all', () => {
    const from = { kind: 'plate', locationId: 'cafe', variant: 'dawn' } as const;
    expect(refDrift(ref({ pin: 'plate-night-old', from }), ctx())).toBe(false);
  });
});
