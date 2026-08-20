/**
 * The adoption guard: bytes that already exist recorded as the output of the task that would have
 * produced them (`docs/plans/archive/chunked-prompts.md` §13).
 *
 * These tests cover the safety property rather than the record shape. The identity is computed here
 * from inputs the caller derived, so only a node the project still describes can be marked done,
 * and a task already holding a real render is refused rather than overwritten.
 */
import { makeProject, SCRIPTS } from '@vn/testkit';
import { loadGraph, makeTask } from '@vn/taskgraph';
import type { Asset, Task } from '@vn/types';
import { adopt, adoptionOf } from '../index.js';

/** A run to the gate, and the first portrait it produced with the node that produced it. */
async function rendered(): Promise<{
  p: Awaited<ReturnType<typeof makeProject>>;
  asset: Asset;
  node: Task<'portrait'>;
}> {
  const p = await makeProject({ script: SCRIPTS.branching });
  await p.run();
  const { store, graph } = await p.reload();
  const asset = store.manifest().find((a) => a.kind === 'portrait')!;
  return { p, asset, node: graph.get(asset.sourceTask) as Task<'portrait'> };
}

describe('adoptionOf', () => {
  it('records the bytes at the identity its own inputs hash to', async () => {
    const { p, asset, node } = await rendered();
    try {
      const inputs = { ...node.inputs, prompt: `${node.inputs.prompt}, at dusk` };
      const decided = adoptionOf(
        { kind: node.kind, inputs, output: asset },
        { has: () => true, node: () => undefined },
      );
      if (!decided.ok) throw new Error(decided.reason);

      // The identity is derived rather than passed in, so the record lands where the planner looks
      expect(decided.record.hash).toBe(makeTask(node.kind, inputs).hash);
      expect(decided.record.hash).not.toBe(node.hash);
      expect(decided.record.status).toBe('done');
      expect(decided.record.output).toBe(asset.hash);
      expect(decided.record.attempts).toEqual([
        { attempt: 1, prompt: inputs.prompt, refs: [], output: asset.hash },
      ]);
    } finally {
      await p.cleanup();
    }
  });

  it('refuses bytes the store does not hold', async () => {
    const { p, asset, node } = await rendered();
    try {
      const decided = adoptionOf(
        { kind: node.kind, inputs: node.inputs, output: { ...asset, hash: 'not-in-the-store' } },
        { has: () => false, node: () => undefined },
      );
      expect(decided.ok).toBe(false);
      if (!decided.ok) expect(decided.code).toBe('UNKNOWN_ASSET');
    } finally {
      await p.cleanup();
    }
  });

  // An unchanged identity means nothing about the project moved, so adopting would replace work
  // that really happened, without reporting it
  it('refuses to replace a real render at an identity that has not moved', async () => {
    const { p, asset, node } = await rendered();
    try {
      const decided = adoptionOf(
        { kind: node.kind, inputs: node.inputs, output: asset },
        { has: () => true, node: () => ({ status: 'done', output: 'someone-elses-bytes' }) },
      );
      expect(decided.ok).toBe(false);
      if (!decided.ok) {
        expect(decided.code).toBe('ALREADY_RENDERED');
        expect(decided.reason).toContain('Regenerate instead');
      }
    } finally {
      await p.cleanup();
    }
  });

  it('is idempotent over a node already done with these bytes', async () => {
    const { p, asset, node } = await rendered();
    try {
      const decided = adoptionOf(
        { kind: node.kind, inputs: node.inputs, output: asset },
        { has: () => true, node: () => ({ status: 'done', output: asset.hash }) },
      );
      expect(decided.ok).toBe(true);
    } finally {
      await p.cleanup();
    }
  });
});

describe('adopt', () => {
  it('writes a record the graph replays as done, so the next run skips it', async () => {
    const { p, asset, node } = await rendered();
    try {
      const inputs = { ...node.inputs, prompt: `${node.inputs.prompt}, in the rain` };
      const written = await adopt(
        p.paths,
        { kind: node.kind, inputs, output: asset },
        { has: () => true, node: () => undefined },
      );
      if (!written.ok) throw new Error(written.reason);

      const replayed = (await loadGraph(p.paths)).get(written.record.hash);
      expect(replayed?.status).toBe('done');
      expect(replayed?.output).toBe(asset.hash);
      expect((await loadGraph(p.paths)).ready()).not.toContainEqual(
        expect.objectContaining({ hash: written.record.hash }),
      );
    } finally {
      await p.cleanup();
    }
  });
});
