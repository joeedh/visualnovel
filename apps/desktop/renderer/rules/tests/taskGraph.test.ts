import { layoutGraph } from '../../graph/layout.js';
import { routeEdges } from '../../graph/edges.js';
import {
  BARRIER_ID,
  barrierFor,
  buildDepEdges,
  buildRefEdges,
  ghostsFor,
  subjectOf,
  taskGraphOf,
} from '../taskGraph.js';
import type { ImageParams } from '@vn/types';
import type { PipelineStatus, StoryGraph, Task } from '../../../src/shared/ipc';

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

const status = (tasks: Task[], gatePending: string[] = []): PipelineStatus => ({
  tasks,
  gatePending,
  blockedOnGate: gatePending.length > 0,
});

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

describe('ghostsFor', () => {
  const scenes = story([
    { id: 'arrival', location: 'classroom', characters: ['aiko'] },
    { id: 'rooftop', location: 'roof', characters: [] },
    { id: 'cut', location: 'roof', characters: [], reachable: false },
  ]);

  it('stands in for every reachable scene with no shot tasks, and only those', () => {
    const ghosts = ghostsFor(status([plate('loc', 'classroom')], ['aiko']), scenes);
    expect(ghosts.filter((g) => g.id.startsWith('ghost:shots')).map((g) => g.id)).toEqual([
      'ghost:shots:arrival',
      'ghost:shots:rooftop',
    ]);
  });

  it('estimates the deterministic baseline: one establishing shot plus one per character', () => {
    const ghosts = ghostsFor(status([], ['aiko']), scenes);
    expect(ghosts.find((g) => g.id === 'ghost:shots:arrival')?.count).toBe(2);
    expect(ghosts.find((g) => g.id === 'ghost:shots:rooftop')?.count).toBe(1);
  });

  it('hangs a scene cluster off the location plates it will reference', () => {
    const tasks = [plate('locA', 'classroom'), plate('locB', 'roof')];
    const ghosts = ghostsFor(status(tasks, ['aiko']), scenes);
    expect(ghosts.find((g) => g.id === 'ghost:shots:arrival')?.after).toEqual(['locA']);
  });

  it('marks only the scenes whose cast is still pending as gated', () => {
    const ghosts = ghostsFor(status([], ['aiko']), scenes);
    expect(ghosts.find((g) => g.id === 'ghost:shots:arrival')?.gated).toBe(true);
    expect(ghosts.find((g) => g.id === 'ghost:shots:rooftop')?.gated).toBe(false);
  });

  // Sheets per outfit are not derivable from anything the renderer holds, so the cluster is
  // countless on purpose — a wrong number would be worse than none.
  it('ghosts model sheets for a pending character, with no count', () => {
    const ghosts = ghostsFor(status([portrait('por', 'aiko')], ['aiko']), scenes);
    const sheets = ghosts.find((g) => g.id === 'ghost:sheets:aiko');
    expect(sheets).toMatchObject({ after: ['por'], gated: true });
    expect(sheets?.count).toBeUndefined();
  });

  it('drops the sheet cluster once real sheet tasks exist', () => {
    const sheet = task({
      hash: 'sheet',
      kind: 'model_sheet',
      inputs: {
        characterId: 'aiko',
        outfit: 'uniform',
        angle: 'front',
        prompt: '',
        refs: [],
        params: PARAMS,
      },
    });
    const ghosts = ghostsFor(status([portrait('por', 'aiko'), sheet], ['aiko']), scenes);
    expect(ghosts.some((g) => g.id === 'ghost:sheets:aiko')).toBe(false);
  });

  it('has nothing to infer without the story graph', () => {
    expect(ghostsFor(status([], ['aiko']), null)).toEqual([]);
  });
});

describe('barrierFor', () => {
  const scenes = story([{ id: 'arrival', location: 'classroom', characters: ['aiko'] }]);

  it('is absent when nothing is pending', () => {
    expect(barrierFor(status([]), scenes, [])).toBeNull();
  });

  it('holds up the gated ghosts and no others', () => {
    const st = status([], ['aiko']);
    const ghosts = ghostsFor(st, scenes);
    const barrier = barrierFor(st, scenes, ghosts);
    expect(barrier?.pending).toEqual(['aiko']);
    expect([...(barrier?.below ?? [])].sort()).toEqual([
      'ghost:sheets:aiko',
      'ghost:shots:arrival',
    ]);
  });

  // The one case the ghosts' own flag can't cover: the task was planned while the character
  // was approved, and the approval was withdrawn afterwards.
  it('puts an already-planned shot below the line when its subject is un-approved again', () => {
    const st = status([shot('shotA', 'arrival__beat1', [], [])], ['aiko']);
    expect(barrierFor(st, scenes, [])?.below.has('shotA')).toBe(true);
  });
});

describe('taskGraphOf', () => {
  const scenes = story([
    { id: 'arrival', location: 'classroom', characters: ['aiko'] },
    { id: 'rooftop', location: 'roof', characters: [] },
  ]);

  it('ranks every blocked node strictly below the barrier, and nothing else', () => {
    const model = taskGraphOf(
      status([plate('loc', 'classroom'), portrait('por', 'aiko')], ['aiko']),
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

  // The stated ceiling from the plan. This is a smoke bound, not a benchmark: it exists to
  // catch a derivation that goes quadratic, which is the way this gets slow.
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

    const started = performance.now();
    const model = taskGraphOf(status(tasks), null);
    const layout = layoutGraph(model.graph);
    const routes = routeEdges(layout, model.edges);
    const elapsed = performance.now() - started;

    expect(layout.nodes).toHaveLength(300);
    expect(routes).toHaveLength(360);
    expect(elapsed).toBeLessThan(1000);
  });
});
