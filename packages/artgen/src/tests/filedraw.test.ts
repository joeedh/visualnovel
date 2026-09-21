/**
 * Filing what an interactive graph run drew. The bytes come from the executor rather than the
 * store, and the slot's take is written through the same rules adoption uses, so the cases here
 * are the ones adoption cannot show: the `graph` stamp, a portrait draft, and a run whose
 * identity the project cannot state.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { placeholderPng } from '@vn/providers';
import type { ShotsFile, TaskAttempt } from '@vn/types';
import { fileGraphDraw } from '../index.js';

jest.setTimeout(60_000);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes that read as a PNG rather than as mock art; `fileGraphDraw` looks no deeper than that. */
function drawn(seed: number): Uint8Array {
  return new Uint8Array([...PNG_SIGNATURE, ...new Array<number>(48).fill(seed)]);
}

async function depsOf(p: TestProject, now?: () => string) {
  const { config, store } = await p.reload();
  return { config, paths: p.paths, store, ...(now === undefined ? {} : { now }) };
}

async function records(p: TestProject, taskHash: string) {
  const log = await p.read('vngen/state/tasks.jsonl');
  return log
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { hash: string; status: string; attempts: TaskAttempt[] })
    .filter((t) => t.hash === taskHash);
}

describe('fileGraphDraw', () => {
  it('files a frame as the current, unapproved take, stamped as drawn by a graph', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await p.approveAll();
      await p.run();
      const before = JSON.parse(await p.read('vngen/work/shots/arrival.json')) as ShotsFile;
      const shotId = before.shots[0]!.id;
      const rendered = before.shots[0]!.shotData!.image!;

      const at = '2026-09-21T10:00:00.000Z';
      const filed = await fileGraphDraw(await depsOf(p, () => at), {
        bytes  : drawn(3),
        ext    : 'png',
        slot   : { kind: 'shot', sceneId: 'arrival', shotId },
        prompt : 'what the image node was asked',
        modelId: 'graph-image',
      });
      expect(filed.ok).toBe(true);
      if (!filed.ok) return;
      expect(filed.plan.supersedes).toBe(rendered);

      const { graph, store } = await p.reload();
      const row = store.manifest().find((a) => a.hash === filed.plan.ref.hash)!;
      expect(row).toMatchObject({
        kind   : 'shot_image',
        current: true,
        via    : 'graph',
        at,
        prompt    : 'what the image node was asked',
        modelId   : 'graph-image',
        sourceTask: filed.plan.taskHash,
      });
      expect(row.accepted).toBeFalsy();
      // The frame it replaced is history: no longer current, and its bytes still in the store
      expect(store.manifest().find((a) => a.hash === rendered)!.current).toBeFalsy();
      expect(store.has(rendered)).toBe(true);

      expect(graph.get(filed.plan.taskHash)).toMatchObject({
        status: 'done',
        output: filed.plan.ref.hash,
      });
      const last = (await records(p, filed.plan.taskHash)).at(-1)!;
      expect(last.attempts.at(-1)).toMatchObject({ via: 'graph', at, output: filed.plan.ref.hash });

      const after = JSON.parse(await p.read('vngen/work/shots/arrival.json')) as ShotsFile;
      expect(after.shots[0]!.shotData).toMatchObject({
        image    : filed.plan.ref.hash,
        proseHash: expect.any(String),
      });

      // The next scheduled run adopts the filed frame rather than drawing the slot again
      const summary = await p.run();
      expect(summary.ran.some((t) => t.hash === filed.plan.taskHash)).toBe(false);
      expect((await p.reload()).graph.get(filed.plan.taskHash)!.output).toBe(filed.plan.ref.hash);
    } finally {
      await p.cleanup();
    }
  });

  it('files a portrait as a draft for the gate', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const filed = await fileGraphDraw(await depsOf(p), {
        bytes  : drawn(5),
        ext    : 'png',
        slot   : { kind: 'portrait', characterId: 'aiko' },
        prompt : '',
        modelId: 'graph-image',
      });
      expect(filed.ok).toBe(true);
      if (!filed.ok) return;
      const { model, store } = await p.reload();
      const row = store.manifest().find((a) => a.hash === filed.plan.ref.hash)!;
      expect(row).toMatchObject({
        kind     : 'portrait',
        current  : true,
        via      : 'graph',
        satisfies: [{ characterId: 'aiko' }],
      });
      // An empty prompt from the graph falls back to the slot's own, so the row has provenance
      expect(row.prompt).toBeTruthy();
      expect(model.characters.get('aiko')!.approvedPortrait).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  });

  it('refuses mock art and a slot whose identity the project cannot state', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const deps = await depsOf(p);
      expect(
        await fileGraphDraw(deps, {
          bytes  : placeholderPng('seed'),
          ext    : 'png',
          slot   : { kind: 'portrait', characterId: 'aiko' },
          prompt : '',
          modelId: 'mock',
        }),
      ).toMatchObject({ ok: false, code: 'MOCK_PLACEHOLDER' });

      // No storyboard yet, so no shot slot exists to be the output of
      expect(
        await fileGraphDraw(deps, {
          bytes  : drawn(7),
          ext    : 'png',
          slot   : { kind: 'shot', sceneId: 'arrival', shotId: 'shot-1' },
          prompt : '',
          modelId: 'graph-image',
        }),
      ).toMatchObject({ ok: false, code: 'NO_SUCH_SLOT' });
      expect((await p.reload()).store.manifest()).toEqual([]);
    } finally {
      await p.cleanup();
    }
  });
});
