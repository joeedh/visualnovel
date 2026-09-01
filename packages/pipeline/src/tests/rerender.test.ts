/**
 * What an authored change does to a picture the pipeline has given up on. Art notes go into the
 * prompt, so writing one re-keys the task: the identity that failed becomes an orphan and a fresh
 * node is planned in its place, with a retry budget of its own. That is what makes a failure
 * recoverable without any requeue machinery, and it holds for a fault and for a frame P7 flagged
 * alike.
 */
import type { AnyTask, TaskInputs } from '@vn/types';
import { StubImageBackend, type ImageBackend } from '@vn/providers';
import { setArtNotes } from '@vn/artgen';
import { loadConfig } from '@vn/config';
import { readShots } from '@vn/store';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';

jest.setTimeout(120_000);

const BLOCKING =
  '{"reviewer":"r","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';

/** Rejects the first `failures` calls and then behaves like the stub, so an outage is scripted. */
function flakyImages(failures: number, message: string): ImageBackend {
  const stub = new StubImageBackend();
  let calls = 0;
  const fail = (): boolean => calls++ < failures;
  return {
    modelId: 'flaky-image',
    generate: (prompt, refs, params) =>
      fail() ? Promise.reject(new Error(message)) : stub.generate(prompt, refs, params),
    edit: (base, prompt, refs, params) =>
      fail() ? Promise.reject(new Error(message)) : stub.edit(base, prompt, refs, params),
  };
}

/**
 * The `art.setNotes` rung a location_ref task's own inputs name. The kind is checked before the
 * cast so a task of another kind says so here, rather than reaching `setArtNotes` as the rung
 * `location:undefined/undefined` and failing several packages away.
 */
function locationRung(task: AnyTask): string {
  if (task.kind !== 'location_ref') throw new Error(`not a location_ref task: ${task.kind}`);
  const inputs = task.inputs as TaskInputs['location_ref'];
  return `location:${inputs.locationId}/${inputs.variant}`;
}

/**
 * The rung for a shot, found by asking each scene's storyboard which one holds it. Derived rather
 * than assembled from the shot id, which is the decomposer's business and not this test's.
 */
async function shotRung(p: TestProject, task: AnyTask): Promise<string> {
  const { shotId } = task.inputs as TaskInputs['shot_image'];
  const { model } = await p.reload();
  for (const scene of model.scenes.values()) {
    const lineIds = new Set(scene.lines.map((l) => l.id));
    const loaded = await readShots(p.paths, scene.id, lineIds);
    if (loaded?.shots.some((s) => s.id === shotId)) return `shot:${scene.id}/${shotId}`;
  }
  throw new Error(`no storyboard holds shot "${shotId}"`);
}

describe('an authored change to a picture the pipeline gave up on', () => {
  it('re-renders a base asset whose art notes changed after it failed', async () => {
    const p = await makeProject({
      script: SCRIPTS.linear,
      // Serial, so the one call `flakyImages` rejects is always the same task's. Under the
      // default cap the pool starts four at once and the loser varies with machine load.
      config: { max_task_attempts: 1, concurrency: 1 },
    });
    try {
      const first = await p.run({ imageBackend: flakyImages(1, 'the model returned 503') });
      const dead = first.ran.find((t) => t.status === 'failed')!;
      expect(dead.kind).toBe('location_ref');

      const config = await loadConfig(p.dir);
      const target = locationRung(dead);
      await setArtNotes(
        { config, paths: p.paths },
        { target, notes: 'rain running down the glass' },
      );

      // The note is part of the prompt, so the plan wants a different node — one the budget the
      // dead identity spent has no say over.
      const second = await p.run();
      const redone = second.ran.find((t) => t.kind === 'location_ref' && t.status === 'done');
      expect(redone).toBeDefined();
      expect(redone!.hash).not.toBe(dead.hash);
      expect((await p.reload()).store.has(redone!.output!)).toBe(true);
      // The identity that failed is an orphan now, so the run neither retries it nor reports it.
      expect(second.retried).toEqual([]);
      expect(second.failed).toEqual([]);
    } finally {
      await p.cleanup();
    }
  });

  it('re-renders a shot P7 flagged, on the same terms', async () => {
    const p = await makeProject({
      script: SCRIPTS.linear,
      // Serial, so the one scripted `BLOCKING` review always lands on the same shot. Under the
      // default cap several shots review at once and which one reads it varies with load.
      config: { max_refine_attempts: 2, concurrency: 1 },
    });
    try {
      await p.run();
      await p.approve('aiko');
      const flagged = (await p.run({ reviewResponses: [BLOCKING] })).ran.find(
        (t) => t.status === 'needs_human',
      )!;
      expect(flagged.kind).toBe('shot_image');

      const config = await loadConfig(p.dir);
      const target = await shotRung(p, flagged);
      await setArtNotes({ config, paths: p.paths }, { target, notes: 'low angle, long lens' });

      // `needs_human` is never requeued, because it asks for a human rather than reporting a
      // fault. Only the new identity the note gives the frame gets it drawn again.
      const third = await p.run();
      const redone = third.ran.find((t) => t.kind === 'shot_image' && t.status === 'done');
      expect(redone).toBeDefined();
      expect(redone!.hash).not.toBe(flagged.hash);
      expect(third.needsHuman.map((t) => t.hash)).not.toContain(flagged.hash);
    } finally {
      await p.cleanup();
    }
  });

  it('leaves an identity terminal when an edit lands back on one that spent its budget', async () => {
    const p = await makeProject({
      script: SCRIPTS.linear,
      // Serial, so the one call `flakyImages` rejects is always the same task's. Under the
      // default cap the pool starts four at once and the loser varies with machine load.
      config: { max_task_attempts: 1, concurrency: 1 },
    });
    try {
      const first = await p.run({ imageBackend: flakyImages(1, 'the model returned 503') });
      const dead = first.ran.find((t) => t.status === 'failed')!;
      expect(dead.kind).toBe('location_ref');
      const config = await loadConfig(p.dir);
      const target = locationRung(dead);

      await setArtNotes(
        { config, paths: p.paths },
        { target, notes: 'rain running down the glass' },
      );
      await p.run();
      await setArtNotes({ config, paths: p.paths }, { target, notes: '' });

      // Clearing the note puts the slot back on the hash that already spent its attempts, and
      // `requeueFailed` counts those for the life of the project. Nothing runs, and the slot has
      // no picture. Asking again is `asset.regenerate`'s job, which is why the desktop app offers
      // it over exactly this failure rather than refusing the asset as an orphan.
      const back = await p.run();
      expect(back.ran).toEqual([]);
      expect(back.retried).toEqual([]);
      expect(back.failed.map((t) => t.hash)).toEqual([dead.hash]);
    } finally {
      await p.cleanup();
    }
  });
});
