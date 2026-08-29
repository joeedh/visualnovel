/**
 * Adoption: recording bytes that already exist as the output of the task that would have produced
 * them (`docs/plans/archive/INDEX.md#chunked-prompts` §13).
 *
 * This is the one `done` record written outside the scheduler, and it has to be unable to forge
 * work that never happened. The property is structural rather than a convention: the caller hands
 * over the task's inputs, derived from the project as it stands, and this module hashes them.
 * There is no way to pass a remembered task hash, so there is no way to mark done a node the
 * project no longer describes.
 *
 * A standalone function rather than something inlined in a command, because the batched version a
 * later plan wants is then a loop plus a transaction boundary — not a second implementation of the
 * same safety property.
 */
import type { Asset, Task, TaskInputs, TaskKind } from '@vn/types';
import { logTask, makeTask } from '@vn/taskgraph';
import type { ProjectPaths } from '@vn/store';

/** Bytes, and the task identity they are being claimed as the output of. */
export interface AdoptRequest<K extends TaskKind> {
  kind: K;
  /** Derived from the project as it stands. Hashed here; a hash may not be passed in its place. */
  inputs: TaskInputs[K];
  /** The asset whose bytes become the output. Already in the store. */
  output: Asset;
  /** The prompt recorded on the attempt. Defaults to the one in `inputs`, when it has one. */
  prompt?: string;
  /**
   * Supersede a render that already holds this identity. Off by default, because refusing is what
   * keeps adoption safe; a caller sets it when the author has been shown which render they are
   * replacing and said yes. Nothing is destroyed either way — `tasks.jsonl` is append-only and the
   * superseded bytes stay in the store.
   */
  replace?: boolean;
}

/** What the guard has to ask about the world: the store, and the graph as replayed. */
export interface AdoptContext {
  /** Whether the store holds these bytes. */
  has(hash: string): boolean;
  /** The node already at a task identity, if the log has one. */
  node(taskHash: string): { status: string; output?: string } | undefined;
}

export type Adoption<K extends TaskKind> =
  | { ok: false; code: string; reason: string }
  | { ok: true; record: Task<K>; note: string };

/**
 * Whether an adoption would land, and the record it would write. A read — {@link adopt} asks this
 * again rather than trusting that a check ran.
 *
 * A `done` node already holding different bytes means the identity did not move, so nothing about
 * the project changed and adopting would quietly replace a real render with something else; that
 * case is refused. When the identity has moved — which is what repinning does — there is no node,
 * and adoption is exactly the right answer. `replace` is the third case: the author means to
 * supersede that render, and says so before the act rather than around it.
 */
export function adoptionOf<K extends TaskKind>(
  req: AdoptRequest<K>,
  ctx: AdoptContext,
): Adoption<K> {
  const short = req.output.hash.slice(0, 8);
  if (!ctx.has(req.output.hash)) {
    return {
      ok: false,
      code: 'UNKNOWN_ASSET',
      reason: `No asset "${req.output.hash}" in the store.`,
    };
  }
  const task = makeTask(req.kind, req.inputs);
  const existing = ctx.node(task.hash);
  if (
    !req.replace &&
    existing?.status === 'done' &&
    existing.output &&
    existing.output !== req.output.hash
  ) {
    return {
      ok: false,
      code: 'ALREADY_RENDERED',
      reason: `That task is already done with ${existing.output.slice(0, 8)}, and nothing about it has changed — adopting ${short} would replace a real render. Regenerate instead.`,
    };
  }
  const prompt = req.prompt ?? ('prompt' in req.inputs ? String(req.inputs.prompt) : undefined);
  const refs = 'refs' in req.inputs ? req.inputs.refs.map((r) => r.hash) : [];
  return {
    ok: true,
    note: `Would record ${short} as the output of ${req.kind} ${task.hash.slice(0, 8)}, so the next run adopts it instead of rendering one.`,
    record: {
      ...task,
      status: 'done',
      output: req.output.hash,
      attempts: [
        { attempt: 1, ...(prompt === undefined ? {} : { prompt }), refs, output: req.output.hash },
      ],
    },
  };
}

/**
 * Write the adoption. `loadGraph` replays the record, `TaskGraph.add` returns the existing `done`
 * node, and `ready()` skips it.
 */
export async function adopt<K extends TaskKind>(
  paths: ProjectPaths,
  req: AdoptRequest<K>,
  ctx: AdoptContext,
): Promise<Adoption<K>> {
  const decided = adoptionOf(req, ctx);
  if (!decided.ok) return decided;
  await logTask(paths, decided.record);
  return decided;
}
