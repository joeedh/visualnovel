/**
 * A slot holding more than one accepted take, and which take it keeps: the storyboard's for a
 * shot, the newest render for anything else.
 */
import type { Asset, AssetKind, Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { lastRenderedAt, overAccepted, resolveBinding } from '../index.js';

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
    refs      : [],
    modelId   : 'm',
    accepted  : true,
    satisfies,
    ...over,
  };
}

const SHOT = { sceneId: 'arrival', shotId: 'arrival__a' };
const CAFE = { locationId: 'cafe', variant: 'night' };
const AIKO = { characterId: 'aiko', outfit: 'uniform' };

const ANGLES: Record<string, string> = {
  'task-front-old': 'front',
  'task-front-new': 'front',
  'task-side'     : 'side',
};
const RENDERED: Record<string, string> = {
  'task-plate-a'  : '2026-01-01T00:00:00Z',
  'task-plate-b'  : '2026-03-01T00:00:00Z',
  'task-front-old': '2026-01-01T00:00:00Z',
  'task-front-new': '2026-02-01T00:00:00Z',
};

const shot = (image: string): Shot => ({
  id         : 'arrival__a',
  sceneId    : 'arrival',
  framing    : 'medium',
  location   : 'night',
  subjects   : [],
  camera     : 'static',
  coversLines: [],
  status     : 'accepted',
  image,
});

function ctx(assets: readonly Asset[], shots?: ReadonlyMap<string, readonly Shot[] | null>) {
  return {
    model: model(
      [character('aiko', 'approved', 'portrait-hash')],
      [scene('arrival', ['aiko'], 'cafe')],
      [location('cafe')],
    ),
    assets,
    angleOf   : (task: string | undefined) => (task ? ANGLES[task] : undefined),
    renderedAt: (task: string) => RENDERED[task],
    ...(shots === undefined ? {} : { shots }),
  };
}

describe('overAccepted', () => {
  it('lists nothing for a manifest whose every slot has one accepted take', () => {
    const assets = [
      asset('frame-1', 'shot_image', [SHOT]),
      asset('frame-2', 'shot_image', [SHOT], { accepted: false }),
      asset('plate-a', 'location_ref', [CAFE]),
    ];
    expect(overAccepted(ctx(assets))).toEqual([]);
  });

  it('keeps the take the storyboard names for a shot', () => {
    const assets = [asset('frame-1', 'shot_image', [SHOT]), asset('frame-2', 'shot_image', [SHOT])];
    const shots = new Map([['arrival', [shot('frame-2')]]]);
    expect(overAccepted(ctx(assets, shots))).toEqual([
      { slot: 'shot:arrival/arrival__a', keep: 'frame-2', drop: ['frame-1'] },
    ]);
  });

  it('keeps the newest render where the storyboard says nothing, and tells sheet angles apart', () => {
    const assets = [
      asset('plate-a', 'location_ref', [CAFE]),
      asset('plate-b', 'location_ref', [CAFE]),
      asset('front-old', 'model_sheet', [AIKO]),
      asset('front-new', 'model_sheet', [AIKO]),
      asset('side', 'model_sheet', [AIKO]),
    ];
    const fixes = overAccepted(ctx(assets));
    expect(fixes).toEqual([
      { slot: 'plate:cafe/night', keep: 'plate-b', drop: ['plate-a'] },
      { slot: 'sheet:aiko/uniform/front', keep: 'front-new', drop: ['front-old'] },
    ]);

    // Applying the fixes leaves every slot resolvable
    const repaired = assets.map((a) =>
      fixes.some((f) => f.drop.includes(a.hash)) ? { ...a, accepted: false } : a,
    );
    const c = ctx(repaired);
    expect(resolveBinding({ kind: 'plate', ...CAFE }, c)).toBe('plate-b');
    expect(resolveBinding({ kind: 'sheet', ...AIKO, angle: 'front' }, c)).toBe('front-new');
  });

  it('falls back to hash order when no render is stamped, so the choice is stable', () => {
    const assets = [
      asset('plate-z', 'location_ref', [CAFE]),
      asset('plate-a', 'location_ref', [CAFE]),
    ];
    const c = { ...ctx(assets), renderedAt: () => undefined };
    expect(overAccepted(c)).toEqual([
      { slot: 'plate:cafe/night', keep: 'plate-a', drop: ['plate-z'] },
    ]);
  });

  it('leaves a portrait to the gate', () => {
    const assets = [
      asset('p1', 'portrait', [{ characterId: 'aiko' }]),
      asset('p2', 'portrait', [{ characterId: 'aiko' }]),
    ];
    expect(overAccepted(ctx(assets))).toEqual([]);
  });
});

describe('lastRenderedAt', () => {
  it('answers the latest attempt stamp, or nothing for an unstamped task', () => {
    const graph = {
      get: (hash: string) =>
        hash === 'stamped'
          ? { attempts: [{ at: '2026-01-02' }, { at: '2026-01-05' }, {}] }
          : hash === 'bare'
            ? { attempts: [{}] }
            : undefined,
    };
    const at = lastRenderedAt(graph);
    expect(at('stamped')).toBe('2026-01-05');
    expect(at('bare')).toBeUndefined();
    expect(at('missing')).toBeUndefined();
  });
});
