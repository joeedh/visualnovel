/**
 * The one property the slot graph can get wrong: promising a picture the planner never plans, or
 * missing one it does.
 *
 * Both sides enumerate from `@vn/model`'s `used.ts` now, but they compose prompts and hash inputs
 * through separate call paths, so agreement is asserted rather than assumed — the planner is run to
 * exhaustion with mock providers and the two hash sets are compared outright.
 *
 * It lives in `@vn/pipeline` because `@vn/artgen` may not import the planner; the pipeline may
 * import both, so this is the only package that can ask the question.
 */
import { projectConfig, type ProjectModel } from '@vn/types';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { buildSlotGraph, type SlotGraph } from '@vn/artgen';
import { character, location, model, scene } from '@vn/testkit';
import { planTasks } from '../index.js';

const config = projectConfig.parse({
  title: 'Test',
  art_style: 'watercolor',
  models: { vision: ['gemini', 'claude'] },
});

/** A café with two variants, and Aiko in a second outfit — so plates, sheets and refs all fan out. */
function project(status: 'approved' | 'draft'): ProjectModel {
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
  return model([c], [s1, scene('s2', ['aiko'], 'cafe')], [cafe]);
}

/** Plan, complete everything planned, plan again — the scheduler's loop with the models removed. */
async function planToExhaustion(m: ProjectModel): Promise<TaskGraph> {
  const graph = new TaskGraph();
  const providers = createMockProviders();
  for (let wave = 0; wave < 5; wave++) {
    await planTasks({ model: m, graph, config, providers });
    for (const t of graph.all()) {
      if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
    }
  }
  return graph;
}

function slots(m: ProjectModel, graph: TaskGraph): SlotGraph {
  return buildSlotGraph({
    model: m,
    assets: [],
    config,
    graph,
    // What the planner decomposed and would have persisted; `buildSlotGraph` never decomposes.
    shots: new Map([...m.scenes].map(([id, s]) => [id, s.shots])),
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
    // Pre-gate the planner emits plates and portraits only. The slot graph still *lists* every
    // sheet and shot — that is what it is for — but must not claim a hash for one.
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
});
