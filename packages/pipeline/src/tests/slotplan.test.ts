/**
 * What a reader solves and what the planner plans agree: every slot with an identity whose scene
 * has cleared the gate is a task some wave planned, and no wave planned a task no slot names.
 *
 * A reader solves facts built from every persisted storyboard, while the planner's model holds
 * only the storyboards it has decomposed, so agreement is asserted rather than assumed. This lives
 * in `@vn/pipeline` because only the planner can move a project through its waves.
 */
import { projectConfig, type Asset, type ProjectModel, type Scene, type Shot } from '@vn/types';
import { TaskGraph, loadGraph } from '@vn/taskgraph';
import { logTask } from '@vn/taskgraph/write';
import { createMockProviders } from '@vn/providers';
import { planAssetCollection } from '@vn/artgen';
import { solve, type Solution } from '@vn/constraint-solver';
import { sceneUnblocked, stillsFamily, type StillsFacts } from '@vn/stills';
import { readShots, withProduction, writeShots } from '@vn/store';
import {
  character,
  location,
  makeProject,
  model,
  scene,
  LISTED_ORDER,
  SCRIPTS,
  type ScriptName,
  type TestProject,
} from '@vn/testkit';
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
 * with no manifest and reads the sheet; the reader always has one and reads the row. The two have
 * to agree, which is what the sheet's copy exists for.
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

function slots(m: ProjectModel, graph: TaskGraph, assets?: readonly Asset[]): Solution {
  // The model's production map holds what the planner decomposed; `solve` never decomposes
  return solve(stillsFamily, {
    model : m,
    assets: assets ?? (m.characters.get('aiko')?.status === 'approved' ? [PORTRAIT_ROW] : []),
    config,
    tasks: graph,
  });
}

const planned = (graph: TaskGraph): string[] =>
  graph
    .all()
    .map((t) => t.hash)
    .sort();

/** Every identity a solution states for a slot whose scene, if it has one, has cleared the gate. */
const promised = (s: Solution, cleared: (sceneId: string) => boolean = () => true): string[] =>
  [...s.slots.values()]
    .filter((state) => state.unit === undefined || cleared(state.unit))
    .map((state) => state.taskHash)
    .filter((h): h is string => !!h)
    .sort();

describe('the solver and the planner agree', () => {
  it('promises exactly the tasks a completed run planned, and no others', async () => {
    const m = project('approved');
    const graph = await planToExhaustion(m);
    expect(planned(graph).length).toBeGreaterThan(0);
    expect(promised(slots(m, graph))).toEqual(planned(graph));
  });

  it('states no identity the planner did not, while the gate is still closed', async () => {
    // Before the gate opens the planner emits plates and portraits only. The solver still lists
    // every sheet and shot, but must not claim a hash for one.
    const m = project('draft');
    const graph = await planToExhaustion(m);
    const s = slots(m, graph);
    expect(promised(s)).toEqual(planned(graph));
    expect([...s.slots.values()].filter((state) => state.blocked).length).toBeGreaterThan(0);
  });

  it('lists the sheets and shots the run has not reached yet, each with its reason', async () => {
    const m = project('draft');
    const s = slots(m, await planToExhaustion(m));
    const sheet = [...s.slots.values()].find((state) => state.kind === 'sheet')!;
    expect(sheet.taskHash).toBeUndefined();
    expect(sheet.blocked).toContain('has not been approved');
  });

  it('gives each member of a staging sheet the identity the planner keyed on that sheet', async () => {
    // Both sides read the same manifest, because a sheet's references resolve from it.
    const m = stagedProject();
    const assets = [PORTRAIT_ROW, PLATE_ROW];
    const graph = await planToExhaustion(m, assets);
    const s = slots(m, graph, assets);

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
      expect(s.slots.get(`shot:s3/${shotId}`)!.taskHash).toBe(planner(shotId).hash);
    }
    expect(promised(s)).toEqual(planned(graph));
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
    const s = solve(stillsFamily, {
      model: withShots,
      config,
      assets: store.manifest(),
      tasks : graph,
    });
    const sceneId = [...withShots.production].find(([, board]) =>
      board.shots.some((shot) => shot.id === grouped[0]),
    )![0];
    for (const shotId of grouped) {
      expect(s.slots.get(`shot:${sceneId}/${shotId}`)!.taskHash).toBe(plannedFor.get(shotId));
    }
  });

  it('keeps a flagged member’s task record when collecting', async () => {
    const { model, config } = await p.reload();
    const collection = await planAssetCollection({ paths: p.paths, model, config });
    expect(collection.tombstones.map((t) => t.hash)).not.toContain(plannedFor.get(grouped[0]!));
  });
});

describe('over every testkit script on disk', () => {
  for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
    it(`${name}: a reader's facts promise what the planner plans, from nothing drawn to everything accepted`, async () => {
      const p = await makeProject({
        script: SCRIPTS[name],
        ...(name === 'listed'
          ? { config: { narrative: 'linear', scenes: [...LISTED_ORDER] } }
          : {}),
      });
      try {
        /**
         * Plans one wave over the project as it stands, solves a reader's facts beside it, and
         * answers how many shots the wave planned.
         */
        const agree = async (): Promise<number> => {
          const planner = await p.reload();
          const tasks = await planTasks({
            model        : planner.model,
            graph        : planner.graph,
            config       : planner.config,
            providers    : createMockProviders(),
            paths        : p.paths,
            readOnlyShots: true,
            assets       : planner.store.manifest(),
          });
          const { model, config: cfg, store } = await p.reload();
          const full = await withProduction(p.paths, model);
          const assets = store.manifest();
          const facts: StillsFacts = {
            model : full,
            config: cfg,
            assets,
            tasks: await loadGraph(p.paths),
          };
          const cleared = (sceneId: string): boolean => sceneUnblocked(full, sceneId, assets);
          expect(promised(solve(stillsFamily, facts), cleared)).toEqual(
            [...new Set(tasks.map((t) => t.hash))].sort(),
          );
          return tasks.filter((t) => t.kind === 'shot_image').length;
        };

        await agree();
        await p.run();
        await agree();
        await p.approveAll();
        await p.run();
        // Once the cast is approved and drawn, the comparison has to reach shots
        expect(await agree()).toBeGreaterThan(0);
        await p.acceptAll();
        await agree();
      } finally {
        await p.cleanup();
      }
    }, 120_000);
  }
});
