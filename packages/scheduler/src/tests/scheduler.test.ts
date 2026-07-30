import type { AnyTask, TaskInputs, TaskStatus } from '@vn/types';
import { StubImageBackend, type ImageBackend } from '@vn/providers';
import { TaskGraph, loadGraph, makeTask } from '@vn/taskgraph';
import { SCRIPTS, makeProject } from '@vn/testkit';
import { requeueFailed } from '../scheduler.js';

/** Shot ids of the `shot_image` tasks in a run. `Task` is generic, so `inputs` needs a cast. */
const shotIds = (tasks: AnyTask[]): string[] =>
  tasks
    .filter((t) => t.kind === 'shot_image')
    .map((t) => (t.inputs as TaskInputs['shot_image']).shotId);

const BLOCKING =
  '{"reviewer":"x","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';

/**
 * An image backend that rejects its first `failures` calls and then behaves like the stub —
 * the transient outage this plan exists for, made deterministic.
 */
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
      // `error` is the reason for the terminal state, whatever the state — here P7's give-up.
      expect(shots.every((t) => t.error?.includes('still has blocking defects'))).toBe(true);
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

  it('records why a task failed — on the node, in the log, and as an attempt', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const summary = await p.run({ imageBackend: flakyImages(Infinity, 'the model exploded') });
      const failed = summary.ran.filter((t) => t.status === 'failed');
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((t) => t.error === 'the model exploded')).toBe(true);

      // A runner that threw pushed no attempt of its own, so the scheduler records the failure.
      for (const t of failed) {
        expect(t.attempts).toHaveLength(1);
        expect(t.attempts[0]).toMatchObject({ attempt: 1, error: 'the model exploded' });
      }

      // The reason is on the node, so the whole-node log line carries it and a replay restores it.
      const replayed = await loadGraph(p.paths);
      for (const t of failed) {
        expect(replayed.get(t.hash)?.status).toBe('failed');
        expect(replayed.get(t.hash)?.error).toBe('the model exploded');
      }
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('retries a failed task on the next run, and the same identity succeeds', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      // One transient outage: exactly one task of the first wave fails.
      const first = await p.run({ imageBackend: flakyImages(1, 'transient 503') });
      const failed = first.ran.filter((t) => t.status === 'failed');
      expect(failed).toHaveLength(1);
      expect(first.retried).toEqual([]);
      const hash = failed[0]!.hash;

      // A fresh run requeues it before the wave loop — the retry is across runs, not within one.
      const second = await p.run({ imageBackend: flakyImages(0, 'unused') });
      expect(second.retried).toEqual([hash]);
      const redone = second.ran.find((t) => t.hash === hash);
      expect(redone?.status).toBe('done');
      expect(redone?.error).toBeUndefined();
      expect((await p.reload()).store.has(redone!.output!)).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('stops requeueing once max_task_attempts is spent', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, config: { max_task_attempts: 1 } });
    try {
      const first = await p.run({ imageBackend: flakyImages(1, 'transient 503') });
      const failed = first.ran.filter((t) => t.status === 'failed');
      expect(failed).toHaveLength(1);

      // The single attempt the budget allows is already spent, so the node stays terminal.
      const second = await p.run({ imageBackend: flakyImages(0, 'unused') });
      expect(second.retried).toEqual([]);
      expect((await loadGraph(p.paths)).get(failed[0]!.hash)?.status).toBe('failed');
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

describe('requeueFailed', () => {
  const params = { modelId: 'mock-image', aspect: '16:9' };

  /** A node in `status`, with one recorded attempt per entry in `errors`. */
  function node(shotId: string, status: TaskStatus, errors: string[] = []): AnyTask {
    const task = makeTask('shot_image', { shotId, prompt: shotId, refs: [], params });
    task.status = status;
    if (errors.length) task.error = errors[errors.length - 1];
    task.attempts = errors.map((error, i) => ({ attempt: i + 1, refs: [], error }));
    return task;
  }

  /** A graph of the given nodes, plus the hashes of the ones the current plan asked for. */
  function graphOf(...tasks: AnyTask[]): TaskGraph {
    const graph = new TaskGraph();
    for (const t of tasks) graph.add(t);
    return graph;
  }

  it('leaves an orphaned failed node alone — tasks.jsonl is never pruned', () => {
    const live = node('live', 'failed', ['boom']);
    const orphan = node('orphan', 'failed', ['boom']);
    const graph = graphOf(live, orphan);

    expect(requeueFailed(graph, new Set([live.hash]), 2).map((t) => t.hash)).toEqual([live.hash]);
    expect(graph.get(live.hash)?.status).toBe('pending');
    expect(graph.get(live.hash)?.error).toBeUndefined();
    // An edited prompt rehashes the task; the node it left behind must never be paid for again.
    expect(graph.get(orphan.hash)?.status).toBe('failed');
  });

  it('counts only attempts that carry an error, and never requeues needs_human', () => {
    // A needs_human shot has one attempt per P7 refine pass — none of them a retry of anything.
    const human = node('human', 'needs_human');
    human.attempts = [1, 2, 3].map((attempt) => ({ attempt, refs: [], output: 'a' }));
    const spent = node('spent', 'failed', ['boom', 'boom again']);
    const fresh = node('fresh', 'failed', ['boom']);
    const graph = graphOf(human, spent, fresh);

    const all = new Set([human.hash, spent.hash, fresh.hash]);
    expect(requeueFailed(graph, all, 2).map((t) => t.hash)).toEqual([fresh.hash]);
    expect(graph.get(human.hash)?.status).toBe('needs_human');
    expect(graph.get(spent.hash)?.status).toBe('failed');
  });
});
