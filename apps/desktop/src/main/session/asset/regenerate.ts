import { activeOutputs, type GraphJournalRecord } from '@vn/gengraph';
import { appendGraphJournal, graphJournalFile, invalidateGenGraph } from '@vn/gengraph/state';
import { logRequeue } from '@vn/taskgraph/maintain';
import { slotOfTask } from '@vn/pipeline';
import { baseRefusal } from '@vn/constraint-solver';
import { parseSlot, resolveSlot, slotLabel, slotTaskHash } from '@vn/stills';
import type { AnyTask } from '@vn/types';
import { graphSlugs, readGraph } from '../../doctree/graphs.js';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject, sessionFacts, withShots } from '../load/project.js';
import { relPath } from '../load/tree.js';

/**
 * Whether a regeneration would land, and the task it would requeue. Shared by the check and the
 * write so the refusal a surface shows is the refusal the command gives.
 *
 * Regenerating any take of a slot regenerates the slot: the task requeued is the slot's
 * identity as the project states it today, not the one these bytes came from. A `stale` take's
 * own task is an orphan (the prompt moved on, so the planner wants a different hash), and
 * requeueing it would spend a real image call reproducing the picture the author just edited
 * away from; `tasks.jsonl` is never pruned, so the log's dead nodes would otherwise stay
 * re-runnable forever. A slot that has since failed re-runs the task that gave up, which no run
 * reaches on its own once its retry budget is spent.
 */
async function regeneration(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: false; reason: string } | { ok: true; task: AnyTask; note: string }> {
  const info = await session.assetInfo(hash);
  if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
  const project = await loadProject(session.dir);
  if (project.store.base.state === 'unavailable') {
    return {
      ok    : false,
      reason: baseRefusal(project.store.base) ?? 'Base assets are unavailable.',
    };
  }
  // A concept's `sourceTask` is a hash of the request and deliberately not a node, so the
  // generic "no task" refusal below would be true and useless. Redrawing one is its own act.
  if (info.kind === 'concept') {
    return {
      ok    : false,
      reason: `${info.label} is a concept: the planner never made it, so there is no task to re-run. Draw it again with art.redraw(hash='${hash}'), which takes an edited prompt.`,
    };
  }
  // Same shape as the concept refusal, for the same reason: an upload's `sourceTask` is a hash of
  // the request that brought the bytes in, and no node ever answered to it.
  if (info.kind === 'reference') {
    return {
      ok    : false,
      reason: `${info.label} is an upload: nothing generated it, so there is no task to re-run. Bring in a different image with asset.upload(file=…).`,
    };
  }
  // A re-render the project has already given up on is the picture the author is asking for,
  // not the one these bytes came from. The scheduler will not requeue it once its retry budget
  // is spent, and the orphan refusal below would send the author to a run that does nothing.
  if (info.failure?.later) {
    const later = project.graph.get(info.failure.task);
    if (later) {
      return {
        ok  : true,
        task: later,
        note: `Would re-run the ${later.kind} that gave up on ${info.label}. The picture on screen is the last one that got through, and it stays until the new render lands.`,
      };
    }
  }
  const from = info.drawnFor ? parseSlot(info.drawnFor) : undefined;
  const slotTask = from
    ? session.gatePart.slotTask(project, from, await withShots(project))
    : undefined;
  const task =
    (slotTask ? project.graph.get(slotTask) : undefined) ??
    (info.sourceTask ? project.graph.get(info.sourceTask) : undefined);
  if (!task) {
    return {
      ok    : false,
      reason: `${info.label} records no task in the graph, so there is nothing to re-run.`,
    };
  }
  if (task.hash !== info.sourceTask && info.stale) {
    return {
      ok: true,
      task,
      note: `Would re-run the ${task.kind} for ${info.drawnFor}: these bytes were rendered from a prompt the project has since changed, so the slot is drawn afresh from today's.`,
    };
  }
  if (info.stale) {
    return {
      ok    : false,
      reason: `${info.label} was rendered from a prompt the project has since changed, so its task is an orphan. Run the pipeline — a fresh task is already planned for it.`,
    };
  }
  // With a fixed seed the same prompt and the same references give back the same bytes, so
  // say so rather than letting an author spend a call finding out.
  const seeded = project.config.image_params.seed !== undefined;
  return {
    ok: true,
    task,
    note: seeded
      ? `Would re-run ${task.kind} for ${info.label} — image_params.seed is fixed, so expect the same picture. Art notes are how the picture changes.`
      : `Would re-run ${task.kind} for ${info.label}.`,
  };
}

/** What `asset.regenerate` would do, without doing it. */
export async function previewRegenerate(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const decided = await regeneration(session, hash);
  return decided.ok ? { ok: true, message: decided.note } : { ok: false, message: decided.reason };
}

/**
 * Put an asset's task back to `pending` so the next run re-renders it. Appending a `pending`
 * snapshot to `tasks.jsonl` performs the requeue — `loadGraph` replays last-writer-wins, which
 * is how `requeueFailed` already works — so this needs no new scheduler machinery.
 *
 * A slot a generation graph draws needs a second step. The graph's own journal resumes every
 * node whose hash still matches, so requeuing the task alone would replay the same picture out
 * of the journal; the paid nodes upstream of that graph's output are invalidated as well.
 */
export async function regenerateAsset(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string; written: string[]; task?: string }> {
  const decided = await regeneration(session, hash);
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const project = await loadProject(session.dir);
  const written = await requeue(session, project, decided.task);
  return {
    ok     : true,
    message: `Queued ${decided.task.kind} ${decided.task.hash.slice(0, 8)} for re-run.`,
    written,
    task: decided.task.hash,
  };
}

/** Puts one task back to `pending`, invalidates the graph bound to it, and reports the writes. */
async function requeue(
  session: WorkspaceSession,
  project: LoadedProject,
  task: AnyTask,
): Promise<string[]> {
  await logRequeue(project.paths, task);
  const written = [relPath(session.dir, project.paths.tasksLog)];
  const invalidated = await invalidateBound(session, project, task);
  if (invalidated !== undefined) written.push(invalidated);
  return written;
}

/**
 * The task one slot's picture is, as the project states it today, and what drawing it would do:
 * a first render where nothing has run, a re-render where one has. Refused with the resolver's
 * own sentence when the slot's identity cannot be stated yet — a shot whose sheets are not
 * drawn, an unknown address.
 */
export async function drawing(
  session: WorkspaceSession,
  slot: string,
): Promise<
  | { ok: true; task: string; queued: AnyTask | undefined; note: string }
  | { ok: false; reason: string }
> {
  const binding = parseSlot(slot);
  if (!binding) return { ok: false, reason: `"${slot}" is not a slot address.` };
  const project = await loadProject(session.dir);
  const refused = baseRefusal(project.store.base);
  if (refused) return { ok: false, reason: refused };
  const decided = resolveSlot(binding, {
    model : await withShots(project),
    config: project.config,
    assets: project.store.manifest(),
    graph : project.graph,
  });
  if (!decided.ok) return { ok: false, reason: decided.reason };
  const hash = slotTaskHash(decided.plan);
  const task = project.graph.get(hash);
  const label = slotLabel(binding);
  if (task === undefined || task.status === 'pending') {
    return { ok: true, task: hash, queued: undefined, note: `Would draw ${label}.` };
  }
  if (task.status === 'running') {
    return Object.hasOwn(session.progress.activity ?? {}, task.hash)
      ? { ok: false, reason: `${label} is being drawn now.` }
      : { ok: true, task: hash, queued: undefined, note: `Would resume drawing ${label}.` };
  }
  const seeded = project.config.image_params.seed !== undefined;
  return {
    ok    : true,
    task  : hash,
    queued: task,
    note: seeded
      ? `Would draw ${label} again — image_params.seed is fixed, so expect the same picture unless the model or the art notes changed.`
      : `Would draw ${label} again.`,
  };
}

/** What `pipeline.draw` would do, without doing it. */
export async function previewDraw(
  session: WorkspaceSession,
  slot: string,
): Promise<{ ok: boolean; message: string }> {
  const decided = await drawing(session, slot);
  return decided.ok ? { ok: true, message: decided.note } : { ok: false, message: decided.reason };
}

/**
 * Draw one slot: requeue its task where it has already run, then run the pipeline for that
 * task and what it needs alone.
 */
export async function drawSlot(
  session: WorkspaceSession,
  slot: string,
): Promise<{ ok: boolean; message: string; written: string[]; task?: string }> {
  const decided = await drawing(session, slot);
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const written =
    decided.queued === undefined
      ? []
      : await requeue(session, await loadProject(session.dir), decided.queued);
  return { ok: true, message: decided.note, written, task: decided.task };
}

/**
 * Invalidates the paid nodes feeding the graph bound to this task's slot, and reports the
 * journal that was appended to. Answers undefined when no graph claims the slot, which is
 * every task in a project that has authored none.
 */
async function invalidateBound(
  session: WorkspaceSession,
  project: LoadedProject,
  task: AnyTask,
): Promise<string | undefined> {
  const slot = slotOfTask(task, sessionFacts(project, await withShots(project)));
  if (slot === undefined) return undefined;

  for (const slug of await graphSlugs(session.dir)) {
    const read = await readGraph(session.dir, slug);
    if (!read.ok) continue;

    const bound = activeOutputs(read.graph).find((output) => output.slot === slot);
    if (bound === undefined) continue;

    await invalidateGenGraph(
      read.graph,
      { record: (record: GraphJournalRecord) => appendGraphJournal(project.paths, slug, record) },
      [bound.id],
    );
    return relPath(session.dir, graphJournalFile(project.paths, slug));
  }
  return undefined;
}
