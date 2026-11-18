/**
 * Checks the one property the slot graph can get wrong: promising a picture the planner never
 * plans, or missing one it does.
 *
 * Both sides enumerate from `@vn/model`'s `used.ts`, but they compose prompts and hash inputs
 * through separate call paths, so agreement is asserted rather than assumed. The planner is run to
 * exhaustion with mock providers and the two hash sets are compared outright.
 *
 * This test lives in `@vn/pipeline` because `@vn/stills` may not import the planner; the pipeline
 * may import both, so this is the only package that can ask the question.
 */
import { projectConfig, type Asset, type ProjectModel, type Scene, type Shot } from '@vn/types';
import { TaskGraph, loadGraph } from '@vn/taskgraph';
import { logTask } from '@vn/taskgraph/write';
import { createMockProviders } from '@vn/providers';
import { planAssetCollection } from '@vn/artgen';
import { buildSlotGraph, type SlotGraph } from '@vn/stills';
import { readShots, withProduction, writeShots } from '@vn/store';
import { character, location, makeProject, model, scene, type TestProject } from '@vn/testkit';
import { planTasks } from '../index.js';

const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'watercolor',
  models   : { vision: ['gemini', 'claude'] },
});

/** A café with two variants, and Aiko in a second outfit — so plates, sheets and refs all fan out. */
function project(status: 'approved' | 'draft', extra: Scene[] = []): ProjectModel {
  const c = character('aiko', status, status === 'approved' ? 'portrait-hash' : undefined);
  c.defaultOutfit = 'uniform';
  c.outfits = [
    { id: 'uniform', characterId: 'aiko', description: 'school uniform' },
    { id: 'track', characterId: 'aiko', description: 'faded club tracksuit' },
  ];
  const cafe = location('cafe');
  cafe.variants = [
    { id: 'day', description: '' },
    { id: 'night', description: 'lamps on' },
  ];
  const s1 = Object.assign(scene('s1', ['aiko'], 'cafe'), { outfits: { aiko: 'track' } });
  return model([c], [s1, scene('s2', ['aiko'], 'cafe'), ...extra], [cafe]);
}

const staged = (id: string, sheet?: string): Shot => ({
  id,
  sceneId    : 's3',
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }],
  coversLines: [],
  ...(sheet === undefined ? {} : { sheet }),
});

/**
 * The same project plus a storyboarded scene, two of whose three shots share a staging sheet with
 * a seed and notes of its own, so the sheet's key is in both members' identity.
 */
function stagedProject(): ProjectModel {
  const m = project('approved', [scene('s3', ['aiko'], 'cafe')]);
  m.production.set('s3', {
    shots : [staged('s3__1', 'g1'), staged('s3__2', 'g1'), staged('s3__3')],
    sheets: { g1: { seed: 4, notes: 'the window stays on the left' } },
  });
  return m;
}

/** Plan, complete everything planned, plan again — the scheduler's loop with the models removed. */
async function planToExhaustion(m: ProjectModel, assets?: readonly Asset[]): Promise<TaskGraph> {
  const graph = new TaskGraph();
  const providers = createMockProviders();
  for (let wave = 0; wave < 5; wave++) {
    await planTasks({ model: m, graph, config, providers, ...(assets ? { assets } : {}) });
    for (const t of graph.all()) {
      if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
    }
  }
  return graph;
}

/**
 * The portrait row whose hash the sheet's `approved_portrait` repeats. The planner here runs
 * with no manifest and reads the sheet; the slot graph always has one and reads the row. The
 * two have to agree, which is what the sheet's copy exists for.
 */
const PORTRAIT_ROW: Asset = {
  hash      : 'portrait-hash',
  ext       : 'png',
  kind      : 'portrait',
  sourceTask: 'task-portrait',
  refs      : [],
  modelId   : 'm',
  satisfies : [{ characterId: 'aiko' }],
  accepted  : true,
  current   : true,
};

/** The café's day plate, current in its slot, which a staging sheet's references resolve from. */
const PLATE_ROW: Asset = {
  hash      : 'plate-hash',
  ext       : 'png',
  kind      : 'location_ref',
  sourceTask: 'task-plate',
  refs      : [],
  modelId   : 'm',
  satisfies : [{ locationId: 'cafe', variant: 'day' }],
  accepted  : true,
  current   : true,
};

function slots(m: ProjectModel, graph: TaskGraph, assets?: readonly Asset[]): SlotGraph {
  // The model's production map holds what the planner decomposed; `buildSlotGraph` never decomposes
  return buildSlotGraph({
    model : m,
    assets: assets ?? (m.characters.get('aiko')?.status === 'approved' ? [PORTRAIT_ROW] : []),
    config,
    graph,
  });
}

const planned = (graph: TaskGraph): string[] =>
  graph
    .all()
    .map((t) => t.hash)
    .sort();
const promised = (g: SlotGraph): string[] =>
  [...g.nodes.values()]
    .map((n) => n.taskHash)
    .filter((h): h is string => !!h)
    .sort();

describe('the slot graph and the planner agree', () => {
  it('promises exactly the tasks a completed run planned, and no others', async () => {
    const m = project('approved');
    const graph = await planToExhaustion(m);
    expect(planned(graph).length).toBeGreaterThan(0);
    expect(promised(slots(m, graph))).toEqual(planned(graph));
  });

  it('states no identity the planner did not, while the gate is still closed', async () => {
    // Before the gate opens the planner emits plates and portraits only. The slot graph still
    // lists every sheet and shot, but must not claim a hash for one.
    const m = project('draft');
    const graph = await planToExhaustion(m);
    const g = slots(m, graph);
    expect(promised(g)).toEqual(planned(graph));
    expect([...g.nodes.values()].filter((n) => n.blocked).length).toBeGreaterThan(0);
  });

  it('lists the sheets and shots the run has not reached yet, each with its reason', async () => {
    const m = project('draft');
    const g = slots(m, await planToExhaustion(m));
    const sheet = [...g.nodes.values()].find((n) => n.binding.kind === 'sheet')!;
    expect(sheet.taskHash).toBeUndefined();
    expect(sheet.blocked).toContain('has not been approved');
  });

  it('gives each member of a staging sheet the identity the planner keyed on that sheet', async () => {
    // Both sides read the same manifest, because a sheet's references resolve from it.
    const m = stagedProject();
    const assets = [PORTRAIT_ROW, PLATE_ROW];
    const graph = await planToExhaustion(m, assets);
    const g = slots(m, graph, assets);

    const planner = (shotId: string): { hash: string; extra?: unknown } => {
      const task = graph
        .all()
        .find(
          (t) => t.kind === 'shot_image' && 'shotId' in t.inputs && t.inputs.shotId === shotId,
        )!;
      return {
        hash : task.hash,
        extra: (task.inputs as { params: { extra?: unknown } }).params.extra,
      };
    };
    expect(planner('s3__1').extra).toHaveProperty('sheet');
    expect(planner('s3__3').extra).toBeUndefined();

    for (const shotId of ['s3__1', 's3__2', 's3__3']) {
      expect(g.nodes.get(`shot:s3/${shotId}`)!.taskHash).toBe(planner(shotId).hash);
    }
    expect(promised(g)).toEqual(planned(graph));
  });
});

/**
 * A project on disk, read the way the desktop and the CLI read one: a fresh model with every
 * storyboard put in its production map by `withProduction`. The group's seed and notes live only in
 * the shots file.
 */
describe('a staging sheet with its own seed and notes, read from disk', () => {
  let p: TestProject;
  let grouped: string[] = [];
  /** The planner's identity for each member, by shot id. */
  const plannedFor = new Map<string, string>();

  beforeAll(async () => {
    p = await makeProject();
    await p.run();
    await p.approveAll();
    await p.run();

    // Two drawn shots of one scene are put in a group, which gives both a new identity
    const { model: before } = await p.reload();
    for (const s of before.scenes.values()) {
      const loaded = await readShots(p.paths, s.id);
      if (!loaded || loaded.shots.length < 2) continue;
      const shots = loaded.shots.map((shot, i) => (i < 2 ? { ...shot, sheet: 'g1' } : shot));
      await writeShots(p.paths, s.id, shots, {
        sheets: { g1: { seed: 9, notes: 'the window stays on the left' } },
      });
      grouped = shots.slice(0, 2).map((shot) => shot.id);
      break;
    }

    const { model, config, store } = await p.reload();
    const graph = await loadGraph(p.paths);
    const tasks = await planTasks({
      model,
      graph,
      config,
      providers    : createMockProviders(),
      paths        : p.paths,
      readOnlyShots: true,
      assets       : store.manifest(),
    });
    for (const t of tasks) {
      if (t.kind === 'shot_image' && 'shotId' in t.inputs && grouped.includes(t.inputs.shotId))
        plannedFor.set(t.inputs.shotId, t.hash);
    }

    // One member left asking for a person, as a P7 flag would leave it
    const flagged = plannedFor.get(grouped[0]!)!;
    graph.setStatus(flagged, 'needs_human');
    await logTask(p.paths, graph.get(flagged)!);
  }, 120_000);

  afterAll(async () => {
    await p.cleanup();
  });

  it('plans both members, keyed on the sheet', () => {
    expect(grouped).toHaveLength(2);
    expect([...plannedFor.keys()].sort()).toEqual([...grouped].sort());
  });

  it('gives each member the identity the planner gave it', async () => {
    const { model, config, store } = await p.reload();
    const graph = await loadGraph(p.paths);
    const withShots = await withProduction(p.paths, model);
    const g = buildSlotGraph({ model: withShots, config, assets: store.manifest(), graph });
    const sceneId = [...withShots.production].find(([, board]) =>
      board.shots.some((s) => s.id === grouped[0]),
    )![0];
    for (const shotId of grouped) {
      expect(g.nodes.get(`shot:${sceneId}/${shotId}`)!.taskHash).toBe(plannedFor.get(shotId));
    }
  });

  it('keeps a flagged member’s task record when collecting', async () => {
    const { model, config } = await p.reload();
    const collection = await planAssetCollection({ paths: p.paths, model, config });
    expect(collection.tombstones.map((t) => t.hash)).not.toContain(plannedFor.get(grouped[0]!));
  });
});
