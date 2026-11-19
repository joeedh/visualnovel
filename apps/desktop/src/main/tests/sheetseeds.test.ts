/**
 * `sheetSeeds` has three callers, each building its facts with its own host's one builder: the
 * planner (`waveFacts`), which keys each member on the sheet; the scheduled runner (`waveFacts`),
 * which seeds a bound graph's sheet nodes; and `gengraph.run` (`sessionFacts`), which seeds an
 * interactive run. For one group, all three have to describe the same sheet.
 */
import { pins } from '@vn/contracts';
import { GenDerivedPrompt, GenImage, GenOutput, Graph, registerGenRuntimes } from '@vn/gengraph';
import { planTasks, sheetSeedsFor } from '@vn/pipeline';
import { createMockProviders } from '@vn/providers';
import { identityStagingSheet, sheetKey } from '@vn/stills';
import { writeShots } from '@vn/store';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { shotsOf, type AssetRef, type Shot } from '@vn/types';
import { loadProject, withShots } from '../session/core.js';
import { graphRunPlan } from '../session/graphseeds.js';

jest.setTimeout(60_000);

registerGenRuntimes();

const frame = (id: string, sheet?: string): Shot => ({
  id,
  sceneId    : 'arrival',
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }],
  camera     : `static, take ${id}`,
  coversLines: [],
  ...(sheet === undefined ? {} : { sheet }),
});

/** The derived prompt drawn through one image node into an output bound to `slot`. */
function boundGraph(slot: string): { graph: Graph; output: GenOutput } {
  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const image = new GenImage();
  const output = new GenOutput();
  for (const node of [prompt, image, output]) graph.add(node);
  graph.connect(prompt.outputs.prompt, image.inputs.prompt);
  graph.connect(image.outputs.image, output.inputs.image);
  output.props['slot']!.setValue(slot);
  return { graph, output };
}

describe(pins(identityStagingSheet), () => {
  let p: TestProject;

  beforeAll(async () => {
    p = await makeProject({ script: SCRIPTS.linear });
    await writeShots(p.paths, 'arrival', [frame('s1', 'g'), frame('s2', 'g'), frame('s3')], {
      sheets: { g: { seed: 7, notes: 'the same corridor throughout' } },
    });
    await p.run();
    await p.approve('aiko');
  });

  afterAll(async () => {
    await p.cleanup();
  });

  it('gives the planner, the scheduled runner and gengraph.run one answer for a sheet group', async () => {
    const project = await loadProject(p.dir);
    const model = await withShots(project);
    const scene = model.scenes.get('arrival')!;
    const shot = shotsOf(model, 'arrival').find((s) => s.id === 's1')!;

    const planned = await planTasks({
      model,
      graph    : project.graph,
      config   : project.config,
      providers: createMockProviders(),
      assets   : project.store.manifest(),
    });
    const member = planned.find((t) => 'shotId' in t.inputs && t.inputs.shotId === 's1')?.inputs;
    const planner = member && 'params' in member ? member.params.extra?.['sheet'] : undefined;

    const runner = sheetSeedsFor({ shot, scene }, { model, store: project.store }, project.config);

    const { graph, output } = boundGraph('shot:arrival/s1');
    const run = await graphRunPlan(project, graph, output.id);
    if (!run.ok) throw new Error(run.reason);
    const seeds = run.plan.seeds;

    expect(runner?.members.map((m) => m.id)).toEqual(['s1', 's2']);
    expect(runner?.refs.length).toBeGreaterThan(0);
    expect(seeds['GenSheetPrompt']).toEqual({ prompt: runner!.prompt });
    expect(JSON.parse(String(seeds['GenSheetRefs']?.['assets'])) as AssetRef[]).toEqual(
      runner!.refs,
    );
    expect(planner).toBe(sheetKey(runner!));
  });
});
