/**
 * The solver's `overHeld` over the stills family: a slot holding more than one current row, and
 * which one it keeps. The storyboard's take for a shot, the identity's output where the task is
 * done, else the row most recently held.
 */
import type { AnyTask, Asset, AssetKind, Shot } from '@vn/types';
import { projectConfig } from '@vn/types';
import { pins } from '@vn/contracts';
import { overHeld } from '@vn/constraint-solver';
import { makeTask, taskHash } from '@vn/taskgraph';
import { character, location, model, scene } from '@vn/testkit';
import {
  plateKind,
  resolveBinding,
  stillsFamily,
  takesCurrencyExclusive,
  type StillsFacts,
} from '../index.js';

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
    current   : true,
    accepted  : false,
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

const config = projectConfig.parse({ title: 'Test', art_style: 'watercolor' });

const shot = (image: string): Shot => ({
  id         : 'arrival__a',
  sceneId    : 'arrival',
  framing    : 'medium',
  location   : 'night',
  subjects   : [],
  camera     : 'static',
  coversLines: [],
  image,
});

/** A task log whose only records are the render stamps in `RENDERED`, plus `extra`. */
function stamped(extra: AnyTask[] = []): StillsFacts['tasks'] {
  const byHash = new Map(extra.map((t) => [t.hash, t]));
  return {
    get: (hash) =>
      byHash.get(hash) ??
      (RENDERED[hash] === undefined
        ? undefined
        : ({ attempts: [{ at: RENDERED[hash] }] } as unknown as AnyTask)),
  };
}

function facts(assets: readonly Asset[], shots?: Shot[], tasks = stamped()): StillsFacts {
  const cafe = location('cafe');
  cafe.variants.push({ id: 'night', description: 'lamps on' });
  const m = model(
    [character('aiko', 'approved', 'portrait-hash')],
    [scene('arrival', ['aiko'], 'cafe')],
    [cafe],
  );
  if (shots) m.production.set('arrival', { shots });
  return {
    model: m,
    assets,
    angleOf: (task: string | undefined) => (task ? ANGLES[task] : undefined),
    tasks,
  };
}

describe(pins(takesCurrencyExclusive), () => {
  describe('overHeld over the stills family', () => {
    it('lists nothing for a manifest whose every slot has one current row', () => {
      const assets = [
        asset('frame-1', 'shot_image', [SHOT]),
        asset('frame-2', 'shot_image', [SHOT], { current: false }),
        asset('plate-a', 'location_ref', [CAFE]),
      ];
      expect(overHeld(stillsFamily, facts(assets))).toEqual([]);
    });

    it('keeps the take the storyboard names for a shot', () => {
      const assets = [
        asset('frame-1', 'shot_image', [SHOT]),
        asset('frame-2', 'shot_image', [SHOT]),
      ];
      expect(overHeld(stillsFamily, facts(assets, [shot('frame-2')]))).toEqual([
        { slot: 'shot:arrival/arrival__a', keep: 'frame-2', drop: ['frame-1'] },
      ]);
    });

    it("keeps the identity's output where the task is done", () => {
      const assets = [
        asset('plate-a', 'location_ref', [CAFE]),
        asset('plate-b', 'location_ref', [CAFE]),
      ];
      const bare = { ...facts(assets), config };
      const decided = plateKind.resolve({ kind: 'plate', ...CAFE }, bare);
      if (!decided.ok) throw new Error(decided.reason);
      const done = {
        ...makeTask('location_ref', decided.plan),
        status: 'done' as const,
        output: 'plate-a',
      };
      expect(done.hash).toBe(taskHash('location_ref', decided.plan));
      const c = { ...facts(assets, undefined, stamped([done])), config };
      expect(overHeld(stillsFamily, c)).toEqual([
        { slot: 'plate:cafe/night', keep: 'plate-a', drop: ['plate-b'] },
      ]);
      // Without a config no identity is stated, so the newer render wins instead
      expect(overHeld(stillsFamily, facts(assets, undefined, stamped([done])))).toEqual([
        { slot: 'plate:cafe/night', keep: 'plate-b', drop: ['plate-a'] },
      ]);
    });

    it('resolves the identity over the facts it is given for that', () => {
      const assets = [
        asset('plate-a', 'location_ref', [CAFE]),
        asset('plate-b', 'location_ref', [CAFE]),
      ];
      const bare = { ...facts(assets), config };
      const decided = plateKind.resolve({ kind: 'plate', ...CAFE }, bare);
      if (!decided.ok) throw new Error(decided.reason);
      const done = { ...makeTask('location_ref', decided.plan), status: 'done' as const };
      const tasks = stamped([{ ...done, output: 'plate-a' }]);
      // The identity is read from `identity`, the rows from `facts`
      const identity = { ...facts(assets, undefined, tasks), config };
      expect(overHeld(stillsFamily, facts(assets), identity)).toEqual([
        { slot: 'plate:cafe/night', keep: 'plate-a', drop: ['plate-b'] },
      ]);
    });

    it('keeps the row most recently held where the log says nothing, and tells sheet angles apart', () => {
      const assets = [
        asset('plate-a', 'location_ref', [CAFE]),
        asset('plate-b', 'location_ref', [CAFE]),
        asset('front-old', 'model_sheet', [AIKO]),
        asset('front-new', 'model_sheet', [AIKO]),
        asset('side', 'model_sheet', [{ ...AIKO, angle: 'side' }]),
      ];
      const fixes = overHeld(stillsFamily, facts(assets));
      expect(fixes).toEqual([
        { slot: 'plate:cafe/night', keep: 'plate-b', drop: ['plate-a'] },
        { slot: 'sheet:aiko/uniform/front', keep: 'front-new', drop: ['front-old'] },
      ]);

      // Applying the fixes leaves every slot resolvable
      const repaired = assets.map((a) =>
        fixes.some((f) => f.drop.includes(a.hash)) ? { ...a, current: false } : a,
      );
      const c = { ...facts(repaired), assets: repaired };
      expect(resolveBinding({ kind: 'plate', ...CAFE }, c)).toBe('plate-b');
      expect(resolveBinding({ kind: 'sheet', ...AIKO, angle: 'front' }, c)).toBe('front-new');
    });

    it("reads the row's own stamp before the task's, so a restored take is newest", () => {
      const assets = [
        asset('plate-a', 'location_ref', [CAFE], { at: '2026-04-01T00:00:00Z' }),
        asset('plate-b', 'location_ref', [CAFE]),
      ];
      expect(overHeld(stillsFamily, facts(assets))).toEqual([
        { slot: 'plate:cafe/night', keep: 'plate-a', drop: ['plate-b'] },
      ]);
    });

    it('falls back to hash order when no render is stamped, so the choice is stable', () => {
      const assets = [
        asset('plate-z', 'location_ref', [CAFE]),
        asset('plate-a', 'location_ref', [CAFE]),
      ];
      const c = facts(assets, undefined, { get: () => undefined });
      expect(overHeld(stillsFamily, c)).toEqual([
        { slot: 'plate:cafe/night', keep: 'plate-a', drop: ['plate-z'] },
      ]);
    });

    // Currency is a row bit for every kind; only approval stays with the gate
    it('repairs a portrait slot like any other', () => {
      const assets = [
        asset('p1', 'portrait', [{ characterId: 'aiko' }]),
        asset('p2', 'portrait', [{ characterId: 'aiko' }]),
      ];
      expect(overHeld(stillsFamily, facts(assets))).toEqual([
        { slot: 'portrait:aiko', keep: 'p1', drop: ['p2'] },
      ]);
    });

    it('repairs a slot no enumeration lists, such as a deleted character', () => {
      const assets = [
        asset('g1', 'portrait', [{ characterId: 'gone' }]),
        asset('g2', 'portrait', [{ characterId: 'gone' }]),
      ];
      expect(overHeld(stillsFamily, facts(assets))).toEqual([
        { slot: 'portrait:gone', keep: 'g1', drop: ['g2'] },
      ]);
    });
  });
});
