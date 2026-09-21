/**
 * An interactive graph run through the session. What can be shown without a real image model:
 * which runs file a take and which stay journal-only, the refusal a bound run gives before it
 * spends, and that a draw filed for a slot is what the approvals popup then lists.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { GenDerivedPrompt, GenImage, GenOutput, Graph, registerGenRuntimes } from '@vn/gengraph';
import type { Node } from '@vn/gengraph';
import { fileGraphDraw } from '@vn/artgen';
import { exists } from '@vn/util';
import { join } from 'node:path';
import { writeGraph } from '../doctree/graphs.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';

jest.setTimeout(60_000);

registerGenRuntimes();

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const drawn = (): Uint8Array =>
  new Uint8Array([...PNG_SIGNATURE, ...new Array<number>(48).fill(9)]);

function setProp(node: Node, key: string, value: unknown): void {
  node.props[key]!.setValue(value);
}

/** The derived prompt drawn through one image node into an output naming `slot` (or nothing). */
function plainGraph(slot?: string): { graph: Graph; image: Node } {
  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const image = new GenImage();
  const output = new GenOutput();
  graph.add(prompt);
  graph.add(image);
  graph.add(output);
  graph.connect(prompt.outputs.prompt, image.inputs.prompt);
  graph.connect(image.outputs.image, output.inputs.image);
  if (slot !== undefined) setProp(output, 'slot', slot);
  return { graph, image };
}

describe('an interactive graph run', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({ script: SCRIPTS.linear });
    session = new WorkspaceSession(p.dir, true, deps);
  });

  afterAll(async () => {
    await p.cleanup();
  });

  it('files only a run to the active output of a bound graph', async () => {
    await writeGraph(p.dir, 'portrait', plainGraph('portrait:aiko').graph);
    const bound = await session.runTarget('portrait');
    expect(bound).toMatchObject({ ok: true, slot: { kind: 'portrait', characterId: 'aiko' } });
    if (!bound.ok) return;
    expect(bound.seeds['GenDerivedPrompt']).toMatchObject({ prompt: expect.any(String) });

    const study = plainGraph();
    await writeGraph(p.dir, 'study', study.graph);
    expect(await session.runTarget('study')).toMatchObject({ ok: true, seeds: {} });
    expect(await session.runTarget('study')).not.toHaveProperty('slot');

    // A run to a node short of the output is a step, filed as nothing
    const step = plainGraph('portrait:aiko');
    await writeGraph(p.dir, 'step', step.graph);
    expect(await session.runTarget('step', String(step.image.id))).not.toHaveProperty('slot');
  });

  it('refuses a bound run before it spends when the identity cannot be stated', async () => {
    // No storyboard, so no frame for a shot output to be the take of
    await writeGraph(p.dir, 'frame', plainGraph('shot:arrival/shot-1').graph);
    const refused = await session.runTarget('frame');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('nothing in this project plans that picture');
    expect((await session.runGraph('frame', { mock: true })).ok).toBe(false);
    expect(await exists(join(p.dir, 'vngen', 'state', 'graphs', 'frame'))).toBe(false);
  });

  it('stays journal-only under mock', async () => {
    const ran = await session.runGraph('portrait', { mock: true });
    expect(ran.ok).toBe(true);
    expect(ran.message).toMatch(/^Ran 3 nodes in portrait\./);
    expect(ran.filed).toBeUndefined();
    expect(ran.written).toEqual([expect.stringContaining('graphs')]);
    expect((await p.reload()).store.manifest()).toEqual([]);
  });

  it('lists a filed draw in the approvals popup, at the gate for a portrait', async () => {
    const { config, store } = await p.reload();
    const filed = await fileGraphDraw(
      { config, paths: p.paths, store },
      {
        bytes  : drawn(),
        ext    : 'png',
        slot   : { kind: 'portrait', characterId: 'aiko' },
        prompt : 'a study of aiko',
        modelId: 'graph-image',
      },
    );
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    const waiting = await session.approvable();
    expect(waiting).toEqual([
      expect.objectContaining({ hash: filed.plan.ref.hash, kind: 'portrait', door: 'gate' }),
    ]);
    expect((await session.assetInfo(filed.plan.ref.hash))!).toMatchObject({
      current : true,
      approved: false,
      via     : 'graph',
    });
  });
});
