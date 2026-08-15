/**
 * Suspension is derived and transitive (`docs/plans/chunked-prompts.md` §13). Nothing here writes
 * a flag; every assertion is a walk over the same manifest twice, with one edit in between.
 */
import type { Asset, AssetKind, Location, ProjectModel, Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { suspendedAssets, suspensionMap, type SuspendContext } from '../index.js';

function asset(
  hash: string,
  kind: AssetKind,
  satisfies: Asset['satisfies'],
  refs: string[] = [],
): Asset {
  return {
    hash,
    ext: 'png',
    kind,
    sourceTask: `task-${hash}`,
    refs,
    modelId: 'm',
    accepted: false,
    satisfies,
  };
}

/** A café whose `night` plate is what everything downstream was drawn from. */
function cafe(pin: string | undefined, mute = false): Location {
  const l = location('cafe');
  l.variants = [
    { id: 'night', description: 'lamps on' },
    {
      id: 'dawn',
      description: 'grey light',
      ...(pin
        ? {
            promptOverride: {
              mode: 'chunks' as const,
              ...(mute ? { mute: ['variant'] } : {}),
              refs: {
                variant: [
                  {
                    pin,
                    ext: 'png',
                    from: { kind: 'plate' as const, locationId: 'cafe', variant: 'night' },
                  },
                ],
              },
            },
          }
        : {}),
    },
  ];
  return l;
}

const SHOT: Shot = {
  id: 'arrival__a',
  sceneId: 'arrival',
  framing: 'medium',
  location: 'dawn',
  subjects: [],
  coversLines: [],
  status: 'pending',
};

/**
 * `night` currently resolves to `newnightplate`; `dawn` was drawn against whatever `pin` says, and
 * the frame was drawn from `dawn`. So a stale pin should suspend two assets, not one.
 */
function ctx(pin: string | undefined, mute = false): SuspendContext {
  const m: ProjectModel = model(
    [character('aiko', 'approved', 'portrait-hash')],
    [scene('arrival', [], 'cafe')],
    [cafe(pin, mute)],
  );
  return {
    model: m,
    assets: [
      asset('oldnightplate', 'location_ref', [{ locationId: 'cafe', variant: 'night' }]),
      {
        ...asset('newnightplate', 'location_ref', [{ locationId: 'cafe', variant: 'night' }]),
        accepted: true,
      },
      asset('plate-dawn', 'location_ref', [{ locationId: 'cafe', variant: 'dawn' }]),
      asset('frame', 'shot_image', [{ sceneId: 'arrival', shotId: 'arrival__a' }], ['plate-dawn']),
    ],
    shots: new Map([['arrival', [SHOT]]]),
    angleOf: () => undefined,
  };
}

describe('suspendedAssets', () => {
  it('says nothing about a project whose references still hold', () => {
    expect(suspendedAssets(ctx('newnightplate'))).toEqual([]);
  });

  it('carries a moved reference downstream, upstream entry first', () => {
    const found = suspendedAssets(ctx('oldnightplate'));
    expect(found.map((s) => s.hash)).toEqual(['plate-dawn', 'frame']);
    expect(found[0]!.reason).toBe(
      'its "variant" reference to cafe — night plate has moved — pinned oldnight, now newnight',
    );
    // The frame authored nothing; it is suspended purely by what it was drawn from.
    expect(found[1]!.via).toBe('plate-dawn');
    expect(found[1]!.reason).toContain('which is suspended');
  });

  it('clears once the reference is repinned to what the slot holds now', () => {
    expect(suspensionMap(ctx('newnightplate')).size).toBe(0);
  });

  it('clears when the chunk that carried the reference is muted', () => {
    // The clause is not being sent, so neither is its evidence — and nothing downstream of it is
    // out of date on account of a reference that no longer reaches the model.
    expect(suspendedAssets(ctx('oldnightplate', true))).toEqual([]);
  });

  it('reports a reference loop already on disk instead of hanging on it', () => {
    // Two plates pinned at each other: the write-time check refuses this, so it only exists in a
    // hand-edited project — and the walk has to come back rather than recurse forever.
    const c = ctx('oldnightplate');
    const night = c.model.locations.get('cafe')!.variants.find((v) => v.id === 'night')!;
    night.promptOverride = {
      mode: 'chunks',
      refs: {
        variant: [
          {
            pin: 'plate-dawn-old',
            ext: 'png',
            from: { kind: 'plate', locationId: 'cafe', variant: 'dawn' },
          },
        ],
      },
    };
    const found = suspendedAssets(c).map((s) => s.hash);
    expect(found).toContain('plate-dawn');
    expect(found).toContain('frame');
  });
});
