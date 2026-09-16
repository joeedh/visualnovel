import { projectConfig, type ProjectModel, type Shot } from '@vn/types';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { character, location, model, scene } from '@vn/testkit';
import { planTasks } from '../index.js';

const config = projectConfig.parse({ title: 'Test', art_style: 'ink', models: {} });

const frame = (id: string, extra: Partial<Shot> = {}): Shot => ({
  id,
  sceneId    : 'room',
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }],
  coversLines: [],
  status     : 'pending',
  ...extra,
});

/** A scene already storyboarded, two of whose three shots share a staging sheet. */
function project(seed?: number): ProjectModel {
  const room = scene('room', ['aiko'], 'classroom');
  room.shots = [
    frame('room__1', { sheet: 'g1' }),
    frame('room__2', { sheet: 'g1' }),
    frame('room__3'),
  ];
  if (seed !== undefined) room.sheets = { g1: { seed } };
  return model([character('aiko', 'approved', 'a'.repeat(64))], [room], [location('classroom')]);
}

/** Plan, complete everything planned, plan again, until the shot tasks exist. */
async function shotTasks(m: ProjectModel): Promise<Map<string, { hash: string; extra?: unknown }>> {
  const graph = new TaskGraph();
  const providers = createMockProviders();
  for (let wave = 0; wave < 4; wave++) {
    await planTasks({ model: m, graph, config, providers });
    for (const t of graph.all()) {
      if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
    }
  }
  const out = new Map<string, { hash: string; extra?: unknown }>();
  for (const t of graph.all()) {
    if (t.kind !== 'shot_image') continue;
    const inputs = t.inputs as { shotId: string; params: { extra?: unknown } };
    out.set(inputs.shotId, { hash: t.hash, extra: inputs.params.extra });
  }
  return out;
}

describe('a staging sheet in the members’ task identity', () => {
  it('keys every member on the sheet, the same key across the group, and no one else', async () => {
    const tasks = await shotTasks(project());
    const one = tasks.get('room__1')!.extra as { sheet: string };
    const two = tasks.get('room__2')!.extra as { sheet: string };
    expect(one.sheet).toMatch(/^[0-9a-f]{64}$/);
    expect(two.sheet).toBe(one.sheet);
    expect(tasks.get('room__3')!.extra).toBeUndefined();
  });

  it('re-keys the members, and only the members, when the group seed moves', async () => {
    const before = await shotTasks(project(1));
    const after = await shotTasks(project(2));
    expect(after.get('room__1')!.hash).not.toBe(before.get('room__1')!.hash);
    expect(after.get('room__2')!.hash).not.toBe(before.get('room__2')!.hash);
    expect(after.get('room__3')!.hash).toBe(before.get('room__3')!.hash);
  });
});
