/**
 * Adoption onto a slot: bytes an author brought become the picture the planner would have drawn.
 *
 * The two contracts worth a real run are the ones a hand-built graph cannot show — `vngen run`
 * skips a slot that was adopted, and superseding a render leaves the old one in the log — so those
 * cases go through the actual scheduler.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { Asset, AssetRef, ImageProvider, ImageResult, ShotsFile } from '@vn/types';
import { adoptSlot, adoptionForSlot, generateConcept } from '../index.js';

// Real-looking bytes: mock-marked art is refused, which is the point of one of these cases.
const image: ImageProvider = {
  generate: (): Promise<ImageResult> =>
    Promise.resolve({
      bytes: new TextEncoder().encode('a repaint an artist handed in'),
      ext: 'png',
      modelId: 'fake-image',
    }),
  edit: () => Promise.reject(new Error('a concept is generated, never edited')),
};

/** A project with one real, un-mock-marked asset in it — the thing an adoption adopts. */
async function withArtwork(script: string): Promise<{ p: TestProject; ref: AssetRef }> {
  const p = await makeProject({ script });
  const { config, model, store } = await p.reload();
  const { ref } = await generateConcept(
    { config, model, store, image },
    { sentence: 'a cleaned-up repaint' },
  );
  return { p, ref };
}

async function depsOf(p: TestProject) {
  const { config, store } = await p.reload();
  return { config, paths: p.paths, store };
}

describe('adoptionForSlot', () => {
  it('refuses each slot it will not adopt onto, by what that slot is', async () => {
    const { p, ref } = await withArtwork(SCRIPTS.branching);
    try {
      const deps = await depsOf(p);
      const refusal = async (slot: Parameters<typeof adoptSlot>[1]['slot'], hash = ref.hash) => {
        const decided = await adoptionForSlot(deps, { hash, slot });
        return decided.ok ? { code: 'ok', reason: decided.plan.note } : decided;
      };

      expect(await refusal({ kind: 'asset', hash: ref.hash })).toMatchObject({
        code: 'NOT_A_SLOT',
      });
      expect(await refusal({ kind: 'portrait', characterId: 'aiko' })).toMatchObject({
        code: 'GATED_SLOT',
        reason: expect.stringContaining('gate.approve'),
      });
      expect(
        await refusal({ kind: 'plate', locationId: 'rooftop', variant: 'noon' }),
      ).toMatchObject({ code: 'NO_SUCH_SLOT' });
      expect(
        await refusal({ kind: 'plate', locationId: 'rooftop', variant: 'evening' }, 'f'.repeat(64)),
      ).toMatchObject({ code: 'UNKNOWN_ASSET' });
    } finally {
      await p.cleanup();
    }
  });

  // The precondition a surface shows and the sentence the act throws are one function, asked twice.
  it('describes the adoption it would make', async () => {
    const { p, ref } = await withArtwork(SCRIPTS.branching);
    try {
      const decided = await adoptionForSlot(await depsOf(p), {
        hash: ref.hash,
        slot: { kind: 'plate', locationId: 'rooftop', variant: 'evening' },
      });
      expect(decided.ok && decided.plan).toMatchObject({
        kind: 'location_ref',
        label: 'rooftop — evening plate',
      });
      expect(decided.ok && decided.plan.supersedes).toBeUndefined();
      expect(decided.ok && decided.plan.note).toContain('adopts it instead of rendering one');
    } finally {
      await p.cleanup();
    }
  });
});

describe('adoptSlot', () => {
  it('is adopted by the next run rather than rendered over', async () => {
    const { p, ref } = await withArtwork(SCRIPTS.branching);
    try {
      // `evening` is the variant the rooftop scene's heading names, so the planner wants a plate
      // for exactly this pair — which is the only way "adopted" means anything.
      const { plan } = await adoptSlot(await depsOf(p), {
        hash: ref.hash,
        slot: { kind: 'plate', locationId: 'rooftop', variant: 'evening' },
      });

      const summary = await p.run();
      expect(summary.ran.some((t) => t.hash === plan.taskHash)).toBe(false);
      const { graph, store } = await p.reload();
      expect(graph.get(plan.taskHash)).toMatchObject({ status: 'done', output: ref.hash });
      // A concept and a plate share the base root, so it is one record whose kind flipped.
      expect(
        store
          .manifest()
          .filter((a) => a.hash === ref.hash)
          .map((a) => a.kind),
      ).toEqual(['location_ref']);
    } finally {
      await p.cleanup();
    }
    // A full scheduler pass over a real project on disk; the default 5s is for pure tests.
  }, 30_000);

  it('supersedes a rendered frame only when told to, and keeps what it superseded', async () => {
    const { p, ref } = await withArtwork(SCRIPTS.linear);
    try {
      await p.run();
      await p.approveAll();
      await p.run();

      const before = JSON.parse(await p.read('vngen/work/shots/arrival.json')) as ShotsFile;
      const shotId = before.shots[0]!.id;
      const rendered = before.shots[0]!.shotData!.image!;
      const slot = { kind: 'shot', sceneId: 'arrival', shotId } as const;

      // Mock-marked bytes are never real output, whatever slot they are offered for.
      expect(await adoptionForSlot(await depsOf(p), { hash: rendered, slot })).toMatchObject({
        code: 'MOCK_PLACEHOLDER',
      });

      const refused = await adoptionForSlot(await depsOf(p), { hash: ref.hash, slot });
      expect(refused).toMatchObject({ code: 'ALREADY_RENDERED' });
      expect(!refused.ok && refused.reason).toContain('replace');

      const { plan } = await adoptSlot(await depsOf(p), { hash: ref.hash, slot, replace: true });
      expect(plan.supersedes).toBe(rendered);

      // The frame is stamped where the runner stamps one, so it reads as current rather than
      // drift-unknown — an artist worked from these lines.
      const after = JSON.parse(await p.read('vngen/work/shots/arrival.json')) as ShotsFile;
      expect(after.shots[0]!.shotData).toMatchObject({
        image: ref.hash,
        proseHash: expect.any(String),
      });

      // Append-only: both records are in the log, and the graph answers the newer one.
      const log = await p.read('vngen/state/tasks.jsonl');
      const records = log
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { hash: string; output?: string })
        .filter((t) => t.hash === plan.taskHash);
      expect(records.map((t) => t.output)).toEqual(expect.arrayContaining([rendered, ref.hash]));
      const { graph, store } = await p.reload();
      expect(graph.get(plan.taskHash)!.output).toBe(ref.hash);

      // One hash, two roots: the frame is filed under `build/` because that is where its kind
      // routes, while the base root still holds the concept it came from. The merged view shows
      // the base row, which is why this reads the build manifest by hand.
      const built = JSON.parse(await p.read('vngen/build/manifest.json')) as { assets: Asset[] };
      expect(built.assets.find((a) => a.hash === ref.hash)).toMatchObject({ kind: 'shot_image' });
      expect(store.manifest().find((a) => a.hash === ref.hash)).toMatchObject({ kind: 'concept' });
    } finally {
      await p.cleanup();
    }
  }, 30_000);
});
