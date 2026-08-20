import { layoutGraph } from '../../graph/layout.js';
import { routeEdges } from '../../graph/edges.js';
import {
  BARRIER_ID,
  barrierFor,
  buildDepEdges,
  buildRefEdges,
  buildSlotEdges,
  slotNodeIds,
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
