import type { AnyTask, TaskInputs } from '@vn/types';
import { loadGraph } from '@vn/taskgraph';
import { SCRIPTS, makeProject } from '@vn/testkit';

/** Shot ids of the `shot_image` tasks in a run. `Task` is generic, so `inputs` needs a cast. */
const shotIds = (tasks: AnyTask[]): string[] =>
  tasks
    .filter((t) => t.kind === 'shot_image')
    .map((t) => (t.inputs as TaskInputs['shot_image']).shotId);

const BLOCKING =
  '{"reviewer":"x","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';

describe('runPipeline — gate-as-barrier end-to-end', () => {
  it('runs to the character gate, then continues after approval, producing assets', async () => {
    const p = await makeProject({ title: 'Demo', script: SCRIPTS.linear });
    try {
      // First run: locations + portraits only; the scene with a cast halts at the gate.
      const first = await p.run();
      expect(first.blockedOnGate).toBe(true);
      expect(first.gate.pending).toEqual(['aiko']);
      expect(first.ran.some((t) => t.kind === 'location_ref' && t.status === 'done')).toBe(true);
      const portrait = first.ran.find((t) => t.kind === 'portrait');
      expect(portrait?.status).toBe('done');
      expect(shotIds(first.ran)).not.toContain('arrival__establishing');

      // The status log is replayable — the graph rebuilds from `tasks.jsonl` alone.
      const replayed = await loadGraph(p.paths);
      expect(replayed.all().filter((t) => t.status === 'done').length).toBeGreaterThanOrEqual(2);

      // Approval goes through disk (character.md + store.accept), not the in-memory model.
      expect(await p.approve('aiko')).toBe(portrait!.output);

      // Second run: model sheets + the blocked scene's shots plan and execute; gate clears.
      const second = await p.run();
      expect(second.gate.cleared).toBe(true);
      expect(second.blockedOnGate).toBe(false);
      expect(second.ran.some((t) => t.kind === 'model_sheet' && t.status === 'done')).toBe(true);
      expect(shotIds(second.ran)).toContain('arrival__establishing');
      const shots = second.ran.filter((t) => t.kind === 'shot_image');
      expect(shots.every((t) => t.status === 'done')).toBe(true);
      // Deduped: work already `done` is not planned again.
      expect(second.ran.some((t) => t.kind === 'portrait')).toBe(false);

      // The manifest records provenance for every produced asset.
      const kinds = new Set((await p.reload()).store.manifest().map((a) => a.kind));
      expect(kinds.has('location_ref')).toBe(true);
      expect(kinds.has('portrait')).toBe(true);
      expect(kinds.has('shot_image')).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('caps the P7 loop and flags needs_human when reviewers keep blocking', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, config: { max_refine_attempts: 2 } });
    try {
      await p.run();
      await p.approve('aiko');

      // Only now do the gated shots run — with a reviewer that refuses every attempt.
      const summary = await p.run({ reviewResponses: [BLOCKING] });
      const shots = summary.ran.filter((t) => t.kind === 'shot_image');
      expect(shots.length).toBeGreaterThan(0);
      expect(shots.every((t) => t.status === 'needs_human')).toBe(true);
      // Capped at max_refine_attempts (2), each recorded for provenance.
      expect(shots.every((t) => t.attempts.length === 2)).toBe(true);
      expect(shots.every((t) => t.attempts.every((a) => a.output))).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('gives up early when the critique repeats, instead of spending the whole cap', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, config: { max_refine_attempts: 6 } });
    try {
      await p.run();
      await p.approve('aiko');

      // Same defect every time, so the second refinement reproduces the first prompt verbatim
      // and the third attempt would be the identical request.
      const summary = await p.run({ reviewResponses: [BLOCKING] });
      const shots = summary.ran.filter((t) => t.kind === 'shot_image');
      expect(shots.length).toBeGreaterThan(0);
      expect(shots.every((t) => t.status === 'needs_human')).toBe(true);
      // Two, not six: the cap is no longer what stops it.
      expect(shots.every((t) => t.attempts.length === 2)).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('dry-run previews cost without producing any assets', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const summary = await p.run({ dryRun: true });
      expect(summary.ran).toHaveLength(0);
      expect(summary.preview.pendingTasks).toBeGreaterThan(0);
      expect((await p.reload()).store.manifest()).toHaveLength(0);
    } finally {
      await p.cleanup();
    }
  });
});
