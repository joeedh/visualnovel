import { layoutGraph } from '../../graph/layout.js';
import { routeEdges } from '../../graph/edges.js';
import {
  BARRIER_ID,
  barrierFor,
  buildDepEdges,
  buildRefEdges,
  buildSlotEdges,
  clusterKeyOf,
  clusterMembers,
  clusteredGraphOf,
  slotNodeIds,
  subgraphFor,
  subjectOf,
  taskGraphOf,
} from '../taskGraph.js';
import type { ImageParams, RefBinding } from '@vn/types';
import type { PipelineStatus, SlotNode, StoryGraph, Task } from '../../../src/shared/ipc';

const PARAMS: ImageParams = { modelId: 'mock-image' };

/** A task with only the fields the derivation reads; `inputs` is per-kind, so it is passed in. */
const task = (over: Partial<Task> & Pick<Task, 'hash' | 'kind' | 'inputs'>): Task => ({
  deps: [],
  status: 'pending',
  attempts: [],
  ...over,
});

const plate = (id: string, locationId: string, output?: string): Task =>
  task({
    hash: id,
    kind: 'location_ref',
    inputs: { locationId, variant: 'day', prompt: '', refs: [], params: PARAMS },
    ...(output ? { output, status: 'done' } : {}),
  });

const portrait = (id: string, characterId: string, output?: string): Task =>
  task({
    hash: id,
    kind: 'portrait',
    inputs: { characterId, prompt: '', refs: [], params: PARAMS },
    ...(output ? { output, status: 'done' } : {}),
  });

const shot = (id: string, shotId: string, refs: string[], deps: string[]): Task =>
  task({
    hash: id,
    kind: 'shot_image',
    deps,
    inputs: {
      shotId,
      prompt: '',
      refs: refs.map((hash) => ({ hash, ext: 'png' })),
      params: PARAMS,
    },
  });

const story = (scenes: Partial<StoryGraph['scenes'][number]>[]): StoryGraph => ({
  scenes: scenes.map((s) => ({
    id: 'x',
    location: 'loc',
    characters: [],
    lines: 3,
    reachable: true,
    ...s,
  })),
  edges: [],
  diagnostics: [],
});

const status = (
  tasks: Task[],
  gatePending: string[] = [],
  slots: SlotNode[] = [],
): PipelineStatus => ({
  tasks,
  gatePending,
  blockedOnGate: gatePending.length > 0,
  slots,
});

/** A slot with only what the derivation reads. Callers pass `refs` in `SlotGraph.order`. */
const slot = (key: string, binding: RefBinding, over: Partial<SlotNode> = {}): SlotNode => ({
  key,
  binding,
  label: key,
  refs: [],
  candidates: [],
  approved: false,
  ...over,
});

const portraitSlot = (id: string, over: Partial<SlotNode> = {}): SlotNode =>
  slot(`portrait:${id}`, { kind: 'portrait', characterId: id }, over);

const sheetSlot = (id: string, over: Partial<SlotNode> = {}): SlotNode =>
  slot(
    `sheet:${id}/uniform/front`,
    {
      kind: 'sheet',
      characterId: id,
      outfit: 'uniform',
      angle: 'front',
    },
    { refs: [`portrait:${id}`], ...over },
  );

const shotSlot = (sceneId: string, shotId: string, refs: string[], over: Partial<SlotNode> = {}) =>
  slot(`shot:${sceneId}/${shotId}`, { kind: 'shot', sceneId, shotId }, { refs, ...over });

const taskView = (t: Task) => ({
  kind: 'task' as const,
  id: t.hash,
  task: t,
  subject: subjectOf(t),
});
const slotView = (s: SlotNode) => ({ kind: 'slot' as const, id: `slot:${s.key}`, slot: s });

/** How many nodes sit in the busiest rank — what a layout is unreadable for being too much of. */
const widestRank = (layout: { nodes: readonly { rank: number }[] }): number => {
  const perRank = new Map<number, number>();
  for (const node of layout.nodes) perRank.set(node.rank, (perRank.get(node.rank) ?? 0) + 1);
  return Math.max(...perRank.values());
};

describe('subjectOf', () => {
  it('names what each kind is of, not what kind it is', () => {
    expect(subjectOf(plate('h1', 'classroom'))).toBe('classroom · day');
    expect(subjectOf(portrait('h2', 'aiko'))).toBe('aiko');
    expect(subjectOf(shot('h3', 'arrival__beat1', [], []))).toBe('arrival__beat1');
  });
});

describe('buildRefEdges', () => {
  const tasks = [
    plate('loc', 'classroom', 'assetLoc'),
    portrait('por', 'aiko', 'assetPor'),
    shot('shotA', 'arrival__beat1', ['assetLoc', 'assetPor'], ['loc']),
  ];

  it('resolves an input ref back to the task that produced the asset', () => {
    expect(buildRefEdges(tasks)).toEqual([
      { id: 'ref:por->shotA', from: 'por', to: 'shotA', kind: 'ref' },
    ]);
  });

  // The location plate reaches the shot both ways. Drawing it twice would claim the pipeline
  // couples them twice; the solid dep edge is the one the scheduler actually orders on.
  it('does not double-draw a ref that is already a dep', () => {
    expect(buildRefEdges(tasks).some((e) => e.from === 'loc')).toBe(false);
    expect(buildDepEdges(tasks)).toEqual([
      { id: 'dep:loc->shotA', from: 'loc', to: 'shotA', kind: 'dep' },
    ]);
  });

  it('skips a ref no task produced — an author-supplied image is not a graph edge', () => {
    const orphan = shot('shotB', 'arrival__beat2', ['handDrawn'], []);
    expect(buildRefEdges([...tasks, orphan]).filter((e) => e.to === 'shotB')).toEqual([]);
  });

  it('drops a dep whose upstream is not in the graph', () => {
    expect(buildDepEdges([shot('shotC', 'x__1', [], ['pruned'])])).toEqual([]);
  });
});

describe('slotNodeIds', () => {
  const slots = [portraitSlot('aiko', { taskHash: 'por' }), portraitSlot('ren')];

  // A slot and the task filling it are the same thing seen from two sides, so the graph draws one
  // box for them rather than showing the same future twice, once as a promise and once as work
  it('collapses a slot into the task the planner actually filed for it', () => {
    const ids = slotNodeIds(status([portrait('por', 'aiko')], [], slots));
    expect(ids.get('portrait:aiko')).toBe('por');
    expect(ids.get('portrait:ren')).toBe('slot:portrait:ren');
  });

  // `resolveSlot` computes an identity from the project as it stands, which says nothing about
  // whether a wave has emitted it — so a hash the graph has never seen is still unplanned work.
  it('leaves a slot its own id when its computed task has never been planned', () => {
    expect(slotNodeIds(status([], [], slots)).get('portrait:aiko')).toBe('slot:portrait:aiko');
  });
});

describe('buildSlotEdges', () => {
  it('draws what a picture will be drawn from, before either end of it exists', () => {
    const slots = [portraitSlot('aiko'), sheetSlot('aiko')];
    expect(buildSlotEdges(status([], [], slots), [])).toEqual([
      {
        id: 'slot:slot:portrait:aiko->slot:sheet:aiko/uniform/front',
        from: 'slot:portrait:aiko',
        to: 'slot:sheet:aiko/uniform/front',
        kind: 'slot',
      },
    ]);
  });

  // Skipped for the same reason `buildRefEdges` skips an author-supplied image: an edge to nowhere
  // claims a coupling the view cannot show either end of
  it('skips a ref naming a slot the graph does not hold — an authored asset pin', () => {
    const pinned = shotSlot('arrival', 'beat1', ['asset:' + 'a'.repeat(64)]);
    expect(buildSlotEdges(status([], [], [pinned]), [])).toEqual([]);
  });

  it('yields to a dep or ref edge already drawn between the same pair', () => {
    const slots = [
      portraitSlot('aiko', { taskHash: 'por' }),
      sheetSlot('aiko', { taskHash: 'sh' }),
    ];
    const tasks = [
      portrait('por', 'aiko'),
      task({
        hash: 'sh',
        kind: 'model_sheet',
        deps: ['por'],
        inputs: {
          characterId: 'aiko',
          outfit: 'uniform',
          angle: 'front',
          prompt: '',
          refs: [],
          params: PARAMS,
        },
      }),
    ];
    const st = status(tasks, [], slots);
    const deps = buildDepEdges(tasks);
    expect(deps).toHaveLength(1);
    expect(buildSlotEdges(st, deps)).toEqual([]);
  });
});

describe('barrierFor', () => {
  const scenes = story([{ id: 'arrival', location: 'classroom', characters: ['aiko'] }]);

  it('is absent when nothing is pending', () => {
    expect(barrierFor(status([]), scenes)).toBeNull();
  });

  // The gate is stated as reachability rather than guessed at per kind: the sheet and the shot
  // land below because aiko's portrait is upstream of both, and neither is named here
  it('holds up everything drawn from a pending portrait, and not the portrait itself', () => {
    const slots = [
      portraitSlot('aiko'),
      sheetSlot('aiko'),
      shotSlot('arrival', 'beat1', ['portrait:aiko']),
      shotSlot('rooftop', 'beat1', ['plate:roof/day']),
    ];
    const barrier = barrierFor(status([], ['aiko'], slots), scenes);
    expect(barrier?.pending).toEqual(['aiko']);
    expect([...(barrier?.below ?? [])].sort()).toEqual([
      'slot:sheet:aiko/uniform/front',
      'slot:shot:arrival/beat1',
    ]);
  });

  // The walk cannot cover this case: the task was planned while the character was approved, and
  // the approval was withdrawn afterwards, so the task's inputs no longer agree with the model
  it('puts an already-planned shot below the line when its subject is un-approved again', () => {
    const st = status([shot('shotA', 'arrival__beat1', [], [])], ['aiko']);
    expect(barrierFor(st, scenes)?.below.has('shotA')).toBe(true);
  });
});

describe('taskGraphOf', () => {
  const scenes = story([
    { id: 'arrival', location: 'classroom', characters: ['aiko'] },
    { id: 'rooftop', location: 'roof', characters: [] },
  ]);

  it('ranks every blocked node strictly below the barrier, and nothing else', () => {
    const model = taskGraphOf(
      status(
        [plate('loc', 'classroom'), portrait('por', 'aiko')],
        ['aiko'],
        [
          portraitSlot('aiko', { taskHash: 'por' }),
          sheetSlot('aiko'),
          shotSlot('arrival', 'beat1', ['portrait:aiko']),
        ],
      ),
      scenes,
    );
    const layout = layoutGraph(model.graph);
    const gate = layout.byId.get(BARRIER_ID);
    expect(gate).toBeDefined();

    for (const node of layout.nodes) {
      if (node.id === BARRIER_ID) continue;
      const below = model.barrier?.below.has(node.id) ?? false;
      expect([node.id, node.rank > (gate?.rank ?? 0)]).toEqual([node.id, below]);
    }
  });

  it('draws one box per picture, whether the planner has filed work for it or not', () => {
    const model = taskGraphOf(
      status(
        [portrait('por', 'aiko')],
        [],
        [portraitSlot('aiko', { taskHash: 'por' }), sheetSlot('aiko')],
      ),
      null,
    );
    expect(model.nodes.get('por')?.kind).toBe('task');
    expect(model.nodes.has('slot:portrait:aiko')).toBe(false);
    expect(model.unplanned.map((s) => s.key)).toEqual(['sheet:aiko/uniform/front']);
    // The sheet hangs off the portrait's task node, since the slot collapsed into it. The edge
    // has to follow, or the promise would point at a box that is not on screen
    expect(model.edges).toContainEqual(
      expect.objectContaining({ from: 'por', to: 'slot:sheet:aiko/uniform/front', kind: 'slot' }),
    );
  });

  it('never routes the ranking edges — they exist to place the line, not to be drawn', () => {
    const model = taskGraphOf(status([portrait('por', 'aiko')], ['aiko']), scenes);
    expect(model.graph.edges.length).toBeGreaterThan(model.edges.length);
    expect(model.edges.some((e) => e.from === BARRIER_ID || e.to === BARRIER_ID)).toBe(false);
  });

  it('has no barrier node at all once the gate is clear', () => {
    const model = taskGraphOf(status([portrait('por', 'aiko', 'assetPor')]), scenes);
    expect(model.barrier).toBeNull();
    expect(model.nodes.has(BARRIER_ID)).toBe(false);
  });

  it('widens the barrier for each further pending character, so the names fit on it', () => {
    const one = taskGraphOf(status([], ['aiko']), scenes);
    const two = taskGraphOf(status([], ['aiko', 'ren']), scenes);
    const widthOf = (m: typeof one): number =>
      m.graph.nodes.find((n) => n.id === BARRIER_ID)?.width ?? 0;
    expect(widthOf(two)).toBeGreaterThan(widthOf(one));
  });

  // The plan states this ceiling as a smoke bound rather than a benchmark: it catches a derivation
  // that has gone quadratic, which is the way this code becomes slow
  it('derives, lays out and routes 300 nodes in well under a second', () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 60; i++) tasks.push(plate(`loc${i}`, `place${i}`, `assetLoc${i}`));
    for (let i = 0; i < 60; i++) tasks.push(portrait(`por${i}`, `char${i}`, `assetPor${i}`));
    for (let i = 0; i < 180; i++) {
      const scene = i % 60;
      tasks.push(
        shot(
          `shot${i}`,
          `scene${scene}__beat${i}`,
          [`assetLoc${scene}`, `assetPor${scene}`],
          [`loc${scene}`],
        ),
      );
    }
    // Half the portraits already have their task; the other half are pure promise, so both the
    // collapse and the slot-only path are on the hot loop.
    const slots: SlotNode[] = [];
    for (let i = 0; i < 60; i++) {
      slots.push(portraitSlot(`char${i}`, i % 2 ? { taskHash: `por${i}` } : {}));
      slots.push(sheetSlot(`char${i}`));
    }

    const started = performance.now();
    const model = taskGraphOf(status(tasks, [], slots), null);
    const layout = layoutGraph(model.graph);
    const routes = routeEdges(layout, model.edges);
    const elapsed = performance.now() - started;

    expect(layout.nodes).toHaveLength(390);
    expect(routes).toHaveLength(420);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('clusterKeyOf', () => {
  it('names the subject each slot binding is about', () => {
    expect(clusterKeyOf(slotView(portraitSlot('aiko')))).toBe('char:aiko');
    expect(clusterKeyOf(slotView(sheetSlot('aiko')))).toBe('char:aiko');
    expect(clusterKeyOf(slotView(shotSlot('arrival', 'beat1', [])))).toBe('scene:arrival');
    const plateSlot = slot('plate:roof/day', { kind: 'plate', locationId: 'roof', variant: 'day' });
    expect(clusterKeyOf(slotView(plateSlot))).toBe('loc:roof');
    // `buildSlotGraph` emits no `asset` binding, so this case exists only to be total.
    const pinned = slot('asset:beef', { kind: 'asset', hash: 'beef' });
    expect(clusterKeyOf(slotView(pinned))).toBe('other:asset:beef');
  });

  it('reads a shot task’s scene out of its namespaced id', () => {
    expect(clusterKeyOf(taskView(shot('s', 'arrival__beat1', [], [])))).toBe('scene:arrival');
    expect(clusterKeyOf(taskView(plate('l', 'classroom')))).toBe('loc:classroom');
    expect(clusterKeyOf(taskView(portrait('p', 'aiko')))).toBe('char:aiko');
  });

  it('stands a review on its own, since it is about one task rather than a subject', () => {
    const review = task({
      hash: 'rv',
      kind: 'vision_review',
      inputs: { target: 'assetPor', spec: '', refs: [], modelId: 'mock-text' },
    });
    expect(clusterKeyOf(taskView(review))).toBe('other:rv');
  });

  it('has no cluster for the barrier, which belongs to the whole graph', () => {
    expect(clusterKeyOf({ kind: 'barrier', id: BARRIER_ID, pending: ['aiko'] })).toBeNull();
  });
});

/**
 * Two scenes off one character and one location. `shotB` refs the plate its own scene already
 * depends on through `shotA`, which is the pair that has to survive as the firmer of the two.
 */
const spread = (): PipelineStatus =>
  status([
    plate('loc', 'classroom', 'assetLoc'),
    portrait('por', 'aiko', 'assetPor'),
    shot('shotA', 'arrival__beat1', ['assetPor'], ['loc']),
    shot('shotB', 'arrival__beat2', ['assetPor', 'assetLoc'], ['shotA']),
    shot('shotC', 'rooftop__beat1', ['assetPor'], []),
  ]);

describe('clusteredGraphOf', () => {
  const clustered = clusteredGraphOf(taskGraphOf(spread(), null));

  it('draws one box per subject', () => {
    expect([...clustered.nodes.keys()]).toEqual([
      'char:aiko',
      'loc:classroom',
      'scene:arrival',
      'scene:rooftop',
    ]);
  });

  it('rolls the members up by state', () => {
    const scene = clustered.nodes.get('scene:arrival');
    expect(scene).toMatchObject({ kind: 'cluster', group: 'scene', label: 'arrival', members: 2 });
    expect(scene?.kind === 'cluster' && scene.counts).toMatchObject({ pending: 2, done: 0 });
    const character = clustered.nodes.get('char:aiko');
    expect(character?.kind === 'cluster' && character.counts.done).toBe(1);
  });

  it('draws one edge per coupled pair, at the firmest kind between them', () => {
    expect(clustered.edges).toEqual([
      {
        id: 'cluster:char:aiko->scene:arrival',
        from: 'char:aiko',
        to: 'scene:arrival',
        kind: 'ref',
      },
      {
        id: 'cluster:char:aiko->scene:rooftop',
        from: 'char:aiko',
        to: 'scene:rooftop',
        kind: 'ref',
      },
      {
        id: 'cluster:loc:classroom->scene:arrival',
        from: 'loc:classroom',
        to: 'scene:arrival',
        kind: 'dep',
      },
    ]);
  });

  it('drops an edge between two members of the same cluster', () => {
    expect(clustered.edges.some((e) => e.from === e.to)).toBe(false);
  });

  // The pending character's own cluster holds both sides of the line: the portrait the gate waits
  // for, and the sheets drawn from it. Neither side is the truth about the cluster as a whole.
  it('gives a gate-pending character’s own cluster no ranking edge, and a downstream one both', () => {
    const downstream = slot(
      'sheet:ren/uniform/front',
      { kind: 'sheet', characterId: 'ren', outfit: 'uniform', angle: 'front' },
      { refs: ['portrait:aiko'] },
    );
    const model = taskGraphOf(
      status(
        [],
        ['aiko'],
        [
          portraitSlot('aiko'),
          sheetSlot('aiko'),
          shotSlot('arrival', 'beat1', ['portrait:aiko']),
          downstream,
        ],
      ),
      story([{ id: 'arrival', characters: ['aiko'] }]),
    );
    const ranking = clusteredGraphOf(model).graph.edges.filter(
      (e) => e.from === BARRIER_ID || e.to === BARRIER_ID,
    );
    expect(ranking.some((e) => e.from === 'char:aiko' || e.to === 'char:aiko')).toBe(false);
    expect(ranking).toContainEqual(expect.objectContaining({ from: BARRIER_ID, to: 'char:ren' }));
    expect(ranking).toContainEqual(
      expect.objectContaining({ from: BARRIER_ID, to: 'scene:arrival' }),
    );
  });

  // The bug this clustering exists for: one shared portrait puts every shot that refs it in the
  // same rank, so the picture is as wide as the project has shots.
  it('keeps the overview narrow where the task graph fans out', () => {
    const tasks: Task[] = [portrait('por', 'aiko', 'assetPor')];
    for (let i = 0; i < 50; i++) {
      tasks.push(shot(`shot${i}`, `scene${i % 10}__beat${i}`, ['assetPor'], []));
    }
    const model = taskGraphOf(status(tasks), null);
    expect(widestRank(layoutGraph(model.graph))).toBe(50);
    expect(widestRank(layoutGraph(clusteredGraphOf(model).graph))).toBe(10);
  });

  // `layoutGraph` promises the same graph draws the same picture, and its input order is part of
  // the graph, so the derivation has to emit clusters and their edges in a stated order.
  it('emits the same order every time it runs', () => {
    const once = clusteredGraphOf(taskGraphOf(spread(), null));
    const twice = clusteredGraphOf(taskGraphOf(spread(), null));
    expect(once.graph.nodes.map((n) => n.id)).toEqual(twice.graph.nodes.map((n) => n.id));
    expect(once.graph.edges.map((e) => e.id)).toEqual(twice.graph.edges.map((e) => e.id));
    expect([...once.nodes.keys()]).toEqual([...twice.nodes.keys()]);
  });
});

describe('clusterMembers', () => {
  const model = taskGraphOf(spread(), null);

  it('opens one cluster back up at task granularity', () => {
    const members = clusterMembers(model, 'scene:arrival');
    expect([...members.nodes.keys()]).toEqual(['shotA', 'shotB']);
    expect(members.edges).toEqual([
      { id: 'dep:shotA->shotB', from: 'shotA', to: 'shotB', kind: 'dep' },
    ]);
  });

  it('leaks no edge whose other end is outside the cluster', () => {
    const members = clusterMembers(model, 'char:aiko');
    expect([...members.nodes.keys()]).toEqual(['por']);
    expect(members.edges).toEqual([]);
  });

  it('is empty for a cluster the latest plan no longer holds', () => {
    expect(clusterMembers(model, 'scene:retired').nodes.size).toBe(0);
  });
});

describe('subgraphFor', () => {
  const model = taskGraphOf(spread(), null);

  it('keeps the target and everything upstream of it, and nothing else', () => {
    const drawn = subgraphFor(model, 'shotA');
    expect([...drawn.nodes.keys()].sort()).toEqual(['loc', 'por', 'shotA']);
    expect(drawn.edges.map((e) => e.id).sort()).toEqual(['dep:loc->shotA', 'ref:por->shotA']);
  });

  it('walks past the first rank, so a diamond brings its whole history', () => {
    const drawn = subgraphFor(model, 'shotB');
    expect([...drawn.nodes.keys()].sort()).toEqual(['loc', 'por', 'shotA', 'shotB']);
  });

  it('is the target alone when nothing feeds it', () => {
    const alone = taskGraphOf(status([], [], [portraitSlot('ren')]), null);
    const drawn = subgraphFor(alone, 'slot:portrait:ren');
    expect([...drawn.nodes.keys()]).toEqual(['slot:portrait:ren']);
    expect(drawn.edges).toEqual([]);
  });

  it('is empty for a target the latest plan no longer holds', () => {
    expect(subgraphFor(model, 'retired').nodes.size).toBe(0);
  });

  it('draws the gate only for a picture the gate has something to do with', () => {
    const gated = taskGraphOf(
      status([], ['aiko'], [portraitSlot('aiko'), sheetSlot('aiko'), portraitSlot('ren')]),
      null,
    );
    expect(subgraphFor(gated, 'slot:sheet:aiko/uniform/front').barrier).not.toBeNull();
    // The portrait the gate is waiting for is what the gate is about, so it carries the rule too.
    expect(subgraphFor(gated, 'slot:portrait:aiko').barrier).not.toBeNull();
    expect(subgraphFor(gated, 'slot:portrait:ren').barrier).toBeNull();
  });
});
