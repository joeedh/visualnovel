/**
 * The stills slots: every picture the project implies, before anything has drawn one, as
 * `solve(stillsFamily, facts)` answers them to every reader.
 *
 * A slot exists whether or not it can state a task identity. Most assertions are therefore about
 * what is enumerated and about the reason each slot gives for having no hash yet, rather than
 * about hashes, which only the planned half has.
 */
import {
  projectConfig,
  type Asset,
  type AssetKind,
  type ProductionData,
  type Shot,
} from '@vn/types';
import { makeTask } from '@vn/taskgraph';
import { solve, type Solution } from '@vn/constraint-solver';
import { character, location, model, scene } from '@vn/testkit';
import {
  locationInputs,
  heldBy,
  imageParams,
  resolveSlot,
  sheetKeys,
  slotTaskHash,
  stillsFamily,
  type SlotGraphContext,
  type SlotResolveContext,
} from '../index.js';

const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'watercolor',
  models   : { vision: ['gemini', 'claude'] },
});

function asset(
  hash: string,
  kind: AssetKind,
  satisfies: Asset['satisfies'],
  current = false,
): Asset {
  return {
    hash,
    ext: 'png',
    kind,
    sourceTask: `task-${hash}`,
    refs      : [],
    modelId   : 'm',
    accepted  : false,
    current,
    satisfies,
  };
}

const SHOT: Shot = {
  id         : 'arrival__a',
  sceneId    : 'arrival',
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }],
  coversLines: [],
};

/** The portrait row Aiko is approved with: current in her slot, and accepted by a person. */
const PORTRAIT: Asset = {
  ...asset('p-aiko', 'portrait', [{ characterId: 'aiko' }], true),
  accepted: true,
};

/**
 * Aiko is approved and in the one reachable scene; the café has two variants, only one of which any
 * shot names — both are still enumerated, because the planner plans both.
 */
function ctx(
  over: Partial<SlotGraphContext> = {},
  board: ProductionData | null = { shots: [SHOT] },
): SlotGraphContext {
  const cafe = location('cafe');
  cafe.variants = [
    { id: 'day', description: '' },
    { id: 'night', description: 'lamps on' },
  ];
  const m = model(
    [character('aiko', 'approved', 'p-aiko')],
    [scene('arrival', ['aiko'], 'cafe')],
    [cafe],
  );
  if (board) m.production.set('arrival', board);
  return {
    model : m,
    assets: [PORTRAIT],
    config,
    ...over,
  };
}

/** The solver's answer for a context, which reads no task log as an empty one. */
function solved(c: SlotGraphContext): Solution {
  const { graph, ...rest } = c;
  return solve(stillsFamily, { ...rest, tasks: graph ?? { get: () => undefined } });
}

describe('solve over the stills family', () => {
  it('enumerates every picture the project implies, drawn or not', () => {
    const keys = [...solved(ctx()).slots.keys()].sort();
    expect(keys).toEqual([
      'plate:cafe/day',
      'plate:cafe/night',
      'portrait:aiko',
      'sheet:aiko/default/back',
      'sheet:aiko/default/front',
      'sheet:aiko/default/side',
      'shot:arrival/arrival__a',
    ]);
  });

  it('has no shot slots for a scene nothing decomposed', () => {
    // Decomposing is an explicit act with a price; a read must never fabricate the answer.
    const graph = solved(ctx({}, null));
    expect([...graph.slots.keys()].filter((k) => k.startsWith('shot:'))).toEqual([]);
  });

  it('states the identity of what the project can, and the sentence for what it cannot', () => {
    const graph = solved(ctx());
    const plate = graph.slots.get('plate:cafe/day')!;
    expect(plate.taskHash).toBe(
      makeTask(
        'location_ref',
        locationInputs(ctx().model.locations.get('cafe')!, 'day', config, imageParams(config)),
      ).hash,
    );
    expect(plate.blocked).toBeUndefined();

    // The frame's identity embeds its plate's asset hash, and nothing has rendered one.
    const frame = graph.slots.get('shot:arrival/arrival__a')!;
    expect(frame.taskHash).toBeUndefined();
    expect(frame.blocked).toContain('has not been rendered');
  });

  it('enumerates sheets before the gate clears, and says why they have no identity', () => {
    const c = ctx({ assets: [{ ...PORTRAIT, accepted: false }] });
    const sheet = solved(c).slots.get('sheet:aiko/default/front')!;
    // The slot is still enumerated even though nothing can be planned for it yet.
    expect(sheet.taskHash).toBeUndefined();
    expect(sheet.blocked).toContain('has not been approved');
  });

  it('inverts the edges the planner derives', () => {
    const graph = solved(ctx());
    expect(graph.slots.get('shot:arrival/arrival__a')!.refs).toEqual([
      'plate:cafe/day',
      'portrait:aiko',
    ]);
    expect(graph.dependents.get('plate:cafe/day')).toEqual(['shot:arrival/arrival__a']);
    expect(graph.dependents.get('portrait:aiko')).toEqual([
      'sheet:aiko/default/front',
      'sheet:aiko/default/side',
      'sheet:aiko/default/back',
      'shot:arrival/arrival__a',
    ]);
  });

  it('orders upstream before everything drawn from it', () => {
    const order = solved(ctx()).order;
    const at = (key: string): number => order.indexOf(key);
    expect(at('portrait:aiko')).toBeLessThan(at('sheet:aiko/default/front'));
    expect(at('plate:cafe/day')).toBeLessThan(at('shot:arrival/arrival__a'));
    expect(at('portrait:aiko')).toBeLessThan(at('shot:arrival/arrival__a'));
    expect(order).toHaveLength(7);
  });

  it('answers every kind, a portrait included, from the row its slot holds', () => {
    expect(solved(ctx()).slots.get('portrait:aiko')!.approved).toBe(true);
    // The sheet still says approved with this hash; the row says nobody accepted it, and the
    // row is what the gate reads once there is a manifest to read.
    const unaccepted = solved(ctx({ assets: [{ ...PORTRAIT, accepted: false }] }));
    expect(unaccepted.slots.get('portrait:aiko')!.approved).toBe(false);
    expect(unaccepted.slots.get('sheet:aiko/default/front')!.blocked).toContain(
      'has not been approved',
    );

    const accepted = solved(
      ctx({
        assets: [
          {
            ...asset('plate1', 'location_ref', [{ locationId: 'cafe', variant: 'day' }], true),
            accepted: true,
          },
        ],
      }),
    );
    expect(accepted.slots.get('plate:cafe/day')!.approved).toBe(true);
    expect(accepted.slots.get('plate:cafe/night')!.approved).toBe(false);
  });

  it('lists a slot’s candidates newest first, by the row’s hold time', () => {
    const plate = (hash: string, at?: string): Asset => ({
      ...asset(hash, 'location_ref', [{ locationId: 'cafe', variant: 'day' }]),
      ...(at === undefined ? {} : { at }),
    });
    const node = solved(
      ctx({ assets: [plate('c'), plate('a', '2026-01-01'), plate('b', '2026-02-01')] }),
    ).slots.get('plate:cafe/day')!;
    expect(node.candidates).toEqual(['b', 'a', 'c']);
  });

  it('reports drafts as candidates even when no one can say which is the slot', () => {
    // With three unaccepted candidates `pick` declines, so the slot names no take. A surface reading that
    // as "nothing drawn" would file three real pictures under "not yet rendered".
    const drafts = ['d1', 'd2', 'd3'].map((h) =>
      asset(h, 'location_ref', [{ locationId: 'cafe', variant: 'day' }]),
    );
    const node = solved(ctx({ assets: drafts })).slots.get('plate:cafe/day')!;
    expect(node.pick).toBeUndefined();
    expect(node.candidates).toEqual(['d1', 'd2', 'd3']);
    expect(node.approved).toBe(false);
  });

  it('comes back from a reference loop already on disk instead of hanging on it', () => {
    // The write-time check refuses this, so it only exists in a hand-edited project.
    const c = ctx();
    const day = c.model.locations.get('cafe')!.variants.find((v) => v.id === 'day')!;
    day.promptOverride = {
      mode: 'chunks',
      refs: {
        variant: [
          { pin: 'x', ext: 'png', from: { kind: 'plate', locationId: 'cafe', variant: 'night' } },
        ],
      },
    };
    const night = c.model.locations.get('cafe')!.variants.find((v) => v.id === 'night')!;
    night.promptOverride = {
      mode: 'chunks',
      refs: {
        variant: [
          { pin: 'y', ext: 'png', from: { kind: 'plate', locationId: 'cafe', variant: 'day' } },
        ],
      },
    };
    const graph = solved(c);
    expect(graph.slots.has('plate:cafe/day')).toBe(true);
    expect(graph.order).toContain('plate:cafe/night');
  });
});

describe('resolveSlot', () => {
  it('refuses an upload and a concept by what they are', () => {
    const decided = resolveSlot({ kind: 'asset', hash: 'abc' }, ctx());
    expect(decided.ok).toBe(false);
    expect(decided.ok === false && decided.code).toBe('NOT_A_SLOT');
  });

  it('names a slot the project does not have', () => {
    const decided = resolveSlot({ kind: 'plate', locationId: 'cafe', variant: 'dusk' }, ctx());
    expect(decided.ok === false && decided.code).toBe('NO_SUCH_SLOT');
  });

  it('states a portrait identity, which adoption alone declines to use', () => {
    const decided = resolveSlot({ kind: 'portrait', characterId: 'aiko' }, ctx());
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(slotTaskHash(decided.plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('a staging-sheet member', () => {
    const members: Shot[] = [
      { ...SHOT, id: 'arrival__a', sheet: 'g1' },
      { ...SHOT, id: 'arrival__b', sheet: 'g1' },
      { ...SHOT, id: 'arrival__c' },
    ];
    const PLATE = asset('plate1', 'location_ref', [{ locationId: 'cafe', variant: 'day' }], true);

    /** The café's day plate has rendered, so a frame's upstream resolves and it states an identity. */
    function staged(over: Partial<SlotGraphContext> = {}): SlotGraphContext {
      const c = ctx(over, { shots: members, sheets: { g1: { seed: 3 } } });
      const cafe = c.model.locations.get('cafe')!;
      const plate = makeTask(
        'location_ref',
        locationInputs(cafe, 'day', config, imageParams(config)),
      );
      const done = { ...plate, status: 'done' as const, output: 'plate1' };
      return { ...c, graph: { get: (hash) => (hash === plate.hash ? done : undefined) } };
    }

    const extraOf = (shotId: string, c: SlotResolveContext): unknown => {
      const decided = resolveSlot({ kind: 'shot', sceneId: 'arrival', shotId }, c);
      if (!decided.ok || decided.plan.kind !== 'shot_image') throw new Error('no identity');
      return decided.plan.inputs.params.extra;
    };

    it('carries the key the planner puts in its params, and a shot in no group carries none', () => {
      const c = staged({ assets: [PORTRAIT, PLATE] });
      const scene = c.model.scenes.get('arrival')!;
      const key = sheetKeys(scene, c.model, config, [PORTRAIT, PLATE]).get('g1');
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(extraOf('arrival__a', c)).toEqual({ sheet: key });
      expect(extraOf('arrival__b', c)).toEqual({ sheet: key });
      expect(extraOf('arrival__c', c)).toBeUndefined();
    });

    it('keys on no references without a manifest, as a plan given none does', () => {
      const { assets: _dropped, ...c } = staged();
      const scene = c.model.scenes.get('arrival')!;
      expect(extraOf('arrival__a', c)).toEqual({
        sheet: sheetKeys(scene, c.model, config, []).get('g1'),
      });
    });
  });
});

describe('heldBy', () => {
  const frame = (hash: string, current = false): Asset =>
    asset(hash, 'shot_image', [{ sceneId: 'arrival', shotId: 'arrival__a' }], current);

  it('names the current takes of the same slot, and nothing else', () => {
    const other = asset(
      'elsewhere',
      'shot_image',
      [{ sceneId: 'arrival', shotId: 'arrival__b' }],
      true,
    );
    const c = ctx({ assets: [frame('new'), frame('old', true), frame('draft'), other] });
    expect(heldBy(frame('new'), c)).toEqual(['old']);
  });

  it('releases a portrait like any other kind, since currency is not the gate', () => {
    const c = ctx({
      assets: [
        asset('p-new', 'portrait', [{ characterId: 'aiko' }]),
        asset('p-aiko', 'portrait', [{ characterId: 'aiko' }], true),
      ],
    });
    expect(heldBy(asset('p-new', 'portrait', [{ characterId: 'aiko' }]), c)).toEqual(['p-aiko']);
  });

  it('names the current takes of every slot a two-slot row serves', () => {
    const both = asset('both', 'shot_image', [
      { sceneId: 'arrival', shotId: 'arrival__a' },
      { sceneId: 'arrival', shotId: 'arrival__b' },
    ]);
    const a = frame('a', true);
    const b = asset('b', 'shot_image', [{ sceneId: 'arrival', shotId: 'arrival__b' }], true);
    expect(heldBy(both, ctx({ assets: [both, a, b] })).sort()).toEqual(['a', 'b']);
  });

  it('tells sheet angles apart by the binding, or by the task where the binding says none', () => {
    const sheet = (hash: string, current = false, angle?: string): Asset =>
      asset(
        hash,
        'model_sheet',
        [{ characterId: 'aiko', outfit: 'default', ...(angle === undefined ? {} : { angle }) }],
        current,
      );
    // Bindings that name their angle separate on their own.
    const named = [
      sheet('front', false, 'front'),
      sheet('side', true, 'side'),
      sheet('front2', true, 'front'),
    ];
    expect(heldBy(sheet('front', false, 'front'), ctx({ assets: named }))).toEqual(['front2']);

    // Rows written before the angle was recorded need the task log to separate them; without one,
    // nothing is released, since four angles share one binding.
    const bare = [sheet('front'), sheet('side', true)];
    expect(heldBy(sheet('front'), ctx({ assets: bare }))).toEqual([]);
    const angles: Record<string, string> = { 'task-front': 'front', 'task-side': 'front' };
    const seeing = ctx({ assets: bare, angleOf: (task) => (task ? angles[task] : undefined) });
    expect(heldBy(sheet('front'), seeing)).toEqual(['side']);
  });
});
