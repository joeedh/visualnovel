/**
 * Promotion: a concept becomes the location plate the planner would have rendered.
 *
 * One contract needs a real run: `vngen run` adopts the promoted image rather than regenerating
 * over it. That case goes through the actual scheduler instead of asserting on the record
 * promotion wrote.
 */
import { readFile } from 'node:fs/promises';
import { makeProject, SCRIPTS } from '@vn/testkit';
import type { AssetRef, ImageProvider, ImageResult } from '@vn/types';
import { generateConcept, promoteConcept, promotionOf } from '../index.js';

const image: ImageProvider = {
  generate: (): Promise<ImageResult> =>
    Promise.resolve({
      bytes  : new TextEncoder().encode('a concept of the rooftop'),
      ext    : 'png',
      modelId: 'fake-image',
    }),
  edit    : () => Promise.reject(new Error('a concept is generated, never edited')),
};

/** A rooftop concept in a fresh project, plus everything a promotion needs. */
async function rooftopConcept(): Promise<{
  p: Awaited<ReturnType<typeof makeProject>>;
  ref: AssetRef;
}> {
  const p = await makeProject({ script: SCRIPTS.branching });
  const { config, model, store } = await p.reload();
  const { ref } = await generateConcept(
    { config, model, store, image },
    { sentence: 'an aerial shot of the rooftop at dawn' },
  );
  return { p, ref };
}

describe('promotionOf', () => {
  // The precondition a surface shows and the sentence the act throws are the same string, because
  // the act asks this function first.
  it('answers the same refusal the act would throw, and the plan it would run', async () => {
    const { p, ref } = await rooftopConcept();
    try {
      const { store } = await p.reload();
      const good = promotionOf(store, { hash: ref.hash, variant: 'dawn' });
      expect(good.ok && good.plan).toMatchObject({ locationId: 'rooftop', variant: 'dawn' });
      expect(good.ok && good.plan.note).toContain('adopts');

      const unknown = promotionOf(store, { hash: 'f'.repeat(64), variant: 'dawn' });
      expect(unknown.ok).toBe(false);
      expect(!unknown.ok && unknown.reason).toMatch(/No asset/);
      const bad = promotionOf(store, { hash: ref.hash, variant: 'a variant' });
      expect(!bad.ok && bad.reason).toMatch(/not a usable variant id/);
    } finally {
      await p.cleanup();
    }
  });
});

describe('promoteConcept', () => {
  it('writes the variant onto the sheet and re-files the bytes as a plate', async () => {
    const { p, ref } = await rooftopConcept();
    try {
      const { config, store } = await p.reload();
      const result = await promoteConcept(
        { config, paths: p.paths, store },
        { hash: ref.hash, variant: 'dawn', description: 'first light on the fence' },
      );

      expect(result).toMatchObject({ locationId: 'rooftop', variant: 'dawn', addedVariant: true });
      const sheet = await readFile(result.file!, 'utf8');
      expect(sheet).toContain('dawn');
      expect(sheet).toContain('first light on the fence');

      // The same bytes keep one record: the kind changes and the plate binding joins the
      // concept's own.
      const { store: reread } = await p.reload();
      const asset = reread.manifest().find((a) => a.hash === ref.hash)!;
      expect(asset.kind).toBe('location_ref');
      expect(asset.sourceTask).toBe(result.taskHash);
      expect(asset.satisfies).toEqual([
        { locationId: 'rooftop' },
        { locationId: 'rooftop', variant: 'dawn' },
      ]);
    } finally {
      await p.cleanup();
    }
  });

  it('is adopted by the next run rather than regenerated over', async () => {
    const { p, ref } = await rooftopConcept();
    try {
      const { config, store } = await p.reload();
      // `evening` is the variant the rooftop scene's heading names, so the planner wants a plate
      // for exactly this location and variant.
      const result = await promoteConcept(
        { config, paths: p.paths, store },
        { hash: ref.hash, variant: 'evening' },
      );

      const summary = await p.run();
      expect(summary.ran.some((t) => t.hash === result.taskHash)).toBe(false);
      const { graph } = await p.reload();
      const node = graph.get(result.taskHash)!;
      expect(node.status).toBe('done');
      expect(node.output).toBe(ref.hash);
    } finally {
      await p.cleanup();
    }
    // A full scheduler pass over a real project on disk needs more than jest's default timeout
  }, 30_000);

  it('refuses an unknown asset, a non-concept, and a variant id nobody could type', async () => {
    const { p, ref } = await rooftopConcept();
    try {
      const { config, store } = await p.reload();
      const deps = { config, paths: p.paths, store };
      await expect(promoteConcept(deps, { hash: 'f'.repeat(64), variant: 'dawn' })).rejects.toThrow(
        /No asset/,
      );
      await expect(promoteConcept(deps, { hash: ref.hash, variant: 'a variant' })).rejects.toThrow(
        /not a usable variant id/,
      );

      await promoteConcept(deps, { hash: ref.hash, variant: 'dawn' });
      const { store: reread } = await p.reload();
      await expect(
        promoteConcept(
          { config, paths: p.paths, store: reread },
          { hash: ref.hash, variant: 'dusk' },
        ),
      ).rejects.toThrow(/not a concept/);
    } finally {
      await p.cleanup();
    }
  });

  it('refuses a concept of a character, and says which command approves a look', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const { config, model, store } = await p.reload();
      const { ref } = await generateConcept(
        { config, model, store, image },
        { sentence: 'aiko, waving', subject: { kind: 'character', id: 'aiko' } },
      );
      await expect(
        promoteConcept({ config, paths: p.paths, store }, { hash: ref.hash, variant: 'dawn' }),
      ).rejects.toThrow(/gate\.approve/);
    } finally {
      await p.cleanup();
    }
  });
});
