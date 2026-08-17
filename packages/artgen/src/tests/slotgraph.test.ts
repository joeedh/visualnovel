/**
 * The slot graph: every picture the project implies, before anything has drawn one.
 *
 * The property under most of this is that a slot exists whether or not it can state a task
 * identity — so the assertions are mostly about what is enumerated and what each node *says* about
 * why it has no hash yet, rather than about hashes, which only the planned half has.
 */
import { projectConfig, type Asset, type AssetKind, type Shot } from '@vn/types';
import { makeTask } from '@vn/taskgraph';
import { character, location, model, scene } from '@vn/testkit';
import {
  buildSlotGraph,
  locationInputs,
  imageParams,
  resolveSlot,
  slotTaskHash,
  type SlotGraphContext,
} from '../index.js';

const config = projectConfig.parse({
  title: 'Test',
  art_style: 'watercolor',
  models: { vision: ['gemini', 'claude'] },
});

function asset(
  hash: string,
  kind: AssetKind,
  satisfies: Asset['satisfies'],
  accepted = false,
): Asset {
  return {
    hash,
    ext: 'png',
    kind,
    sourceTask: `task-${hash}`,
    refs: [],
    modelId: 'm',
    accepted,
    satisfies,
  };
}

const SHOT: Shot = {
  id: 'arrival__a',
  sceneId: 'arrival',
  framing: 'medium',
  location: 'day',
  subjects: [{ characterId: 'aiko' }],
  coversLines: [],
  status: 'pending',
};

/**
 * Aiko is approved and in the one reachable scene; the café has two variants, only one of which any
 * shot names — both are still enumerated, because the planner plans both.
 */
function ctx(over: Partial<SlotGraphContext> = {}): SlotGraphContext {
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
  return {
    model: m,
    assets: [],
    config,
    shots: new Map([['arrival', [SHOT]]]),
    ...over,
  };
}

describe('buildSlotGraph', () => {
  it('enumerates every picture the project implies, drawn or not', () => {
    const keys = [...buildSlotGraph(ctx()).nodes.keys()].sort();
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
    const graph = buildSlotGraph(ctx({ shots: new Map() }));
    expect([...graph.nodes.keys()].filter((k) => k.startsWith('shot:'))).toEqual([]);
  });

  it('states the identity of what the project can, and the sentence for what it cannot', () => {
    const graph = buildSlotGraph(ctx());
    const plate = graph.nodes.get('plate:cafe/day')!;
    expect(plate.taskHash).toBe(
      makeTask(
        'location_ref',
        locationInputs(ctx().model.locations.get('cafe')!, 'day', config, imageParams(config)),
      ).hash,
    );
    expect(plate.blocked).toBeUndefined();

    // The frame's identity embeds its plate's *asset* hash, and nothing has rendered one.
    const frame = graph.nodes.get('shot:arrival/arrival__a')!;
    expect(frame.taskHash).toBeUndefined();
    expect(frame.blocked).toContain('has not been rendered');
  });

  it('enumerates sheets before the gate clears, and says why they have no identity', () => {
    const c = ctx();
    const aiko = c.model.characters.get('aiko')!;
    aiko.status = 'draft';
    delete aiko.approvedPortrait;
    const sheet = buildSlotGraph(c).nodes.get('sheet:aiko/default/front')!;
    // The slot exists — that is the difference between a slot graph and a plan.
    expect(sheet.taskHash).toBeUndefined();
    expect(sheet.blocked).toContain('has not been approved');
  });

  it('inverts the edges the planner derives', () => {
    const graph = buildSlotGraph(ctx());
    expect(graph.nodes.get('shot:arrival/arrival__a')!.refs).toEqual([
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
    const order = buildSlotGraph(ctx()).order;
    const at = (key: string): number => order.indexOf(key);
    expect(at('portrait:aiko')).toBeLessThan(at('sheet:aiko/default/front'));
    expect(at('plate:cafe/day')).toBeLessThan(at('shot:arrival/arrival__a'));
    expect(at('portrait:aiko')).toBeLessThan(at('shot:arrival/arrival__a'));
    expect(order).toHaveLength(7);
  });

  it('answers a portrait from the gate and everything else from the manifest', () => {
    // Aiko is approved with no portrait asset filed at all: approval is the model's word, not the
    // manifest's, and reading `accepted` here would call an approved character unapproved.
    const graph = buildSlotGraph(ctx());
    expect(graph.nodes.get('portrait:aiko')!.approved).toBe(true);

    const accepted = buildSlotGraph(
      ctx({
        assets: [asset('plate1', 'location_ref', [{ locationId: 'cafe', variant: 'day' }], true)],
      }),
    );
    expect(accepted.nodes.get('plate:cafe/day')!.approved).toBe(true);
    expect(accepted.nodes.get('plate:cafe/night')!.approved).toBe(false);
  });

  it('reports drafts as candidates even when no one can say which is the slot', () => {
    // Three unaccepted candidates: `pick` declines, so `hash` is unset — and a surface that read
    // that as "nothing drawn" would file three real pictures under "not yet rendered".
    const drafts = ['d1', 'd2', 'd3'].map((h) =>
      asset(h, 'location_ref', [{ locationId: 'cafe', variant: 'day' }]),
    );
    const node = buildSlotGraph(ctx({ assets: drafts })).nodes.get('plate:cafe/day')!;
    expect(node.hash).toBeUndefined();
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
    const graph = buildSlotGraph(c);
    expect(graph.nodes.has('plate:cafe/day')).toBe(true);
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
});
