/**
 * The agent's collector: `asset.collect`'s rule, run from either host. Agent tools never reach the
 * command registry, so there is no undo point to hold the files for, and `vnauthor` has no undo
 * at all: the tool deletes what it removes at once, and its question says so.
 */
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { loadConfig } from '@vn/config';
import { uncommitted } from '@vn/git';
import {
  applyCollection,
  collectProject,
  collectsNothing,
  describeCollection,
  unreadInputs,
  type CollectionPlan,
} from '@vn/gengraph/state';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './core.js';

const collectArgs = z
  .object({
    oldAnswers: z
      .boolean()
      .optional()
      .describe('also remove graph intermediates that only superseded run records name'),
  })
  .strict();

type CollectArgs = z.infer<typeof collectArgs>;

/** Plans a collection over the project on disk, or answers the refusal that stops one. */
async function planFor(
  a: CollectArgs,
  ctx: ToolContext,
): Promise<{ ok: true; plan: CollectionPlan } | { ok: false; message: string }> {
  const busy = ctx.busy?.();
  if (busy) return { ok: false, message: `Nothing was collected: ${busy} is in progress.` };
  const { model, inputs } = await ctx.workspace.load();
  const unread = unreadInputs([...inputs.diagnostics, ...model.diagnostics]);
  if (unread) return { ok: false, message: unread };
  let config;
  try {
    config = await loadConfig(ctx.workspace.root);
  } catch (err) {
    return { ok: false, message: `Nothing was collected: ${(err as Error).message}` };
  }
  const plan = await collectProject({
    root: ctx.workspace.root,
    model,
    config,
    oldAnswers: a.oldAnswers === true,
  });
  return { ok: true, plan };
}

/** Describes the plan, including how many of its pictures no commit holds. */
async function summary(root: string, plan: CollectionPlan, done = false): Promise<string> {
  const files = plan.assets.files.map((f) => join(root, f.file));
  return describeCollection(plan, { uncommitted: (await uncommitted(files)).size, done });
}

/** Removes art nothing in the project uses, by `asset.collect`'s rule, deleting at once. */
const collectUnusedAssetsTool: Tool<CollectArgs> = {
  name       : 'collect_unused_assets',
  description:
    'Remove the pictures nothing in the project uses any more, with their manifest rows and ' +
    'task records, and the run history of deleted generation graphs. Concepts, uploads and ' +
    'pictures another project made in a shared assets folder are always kept. The files are ' +
    'deleted at once: the app cannot undo this, so the author is asked first, with a count of ' +
    'what goes and how many pictures git could not bring back.',
  mutating   : true,
  confirm    : true,
  args       : collectArgs,
  async confirmText(a, ctx) {
    const planned = await planFor(a, ctx);
    if (!planned.ok) return undefined;
    if (collectsNothing(planned.plan)) return await summary(ctx.workspace.root, planned.plan);
    return (
      `${await summary(ctx.workspace.root, planned.plan)}\nThe files are deleted now, and the ` +
      'app cannot undo it.'
    );
  },
  async run(a, ctx): Promise<ToolResult> {
    const planned = await planFor(a, ctx);
    if (!planned.ok) return fail(planned.message);
    const { plan } = planned;
    if (collectsNothing(plan)) return ok(await summary(ctx.workspace.root, plan));
    // Counted before the files go, because `uncommitted` needs each file's folder to exist
    const said = await summary(ctx.workspace.root, plan, true);
    const applied = await applyCollection(ctx.workspace.root, plan, async (path) => {
      try {
        await rm(join(ctx.workspace.root, path), { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    });
    const written = [
      ...(applied.rows.base.length > 0 ? ['assets/manifest.json'] : []),
      ...(applied.rows.project.length > 0 ? ['vngen/build/manifest.json'] : []),
      ...(applied.tombstoned.length > 0 ? ['vngen/state/tasks.jsonl'] : []),
      ...applied.released,
      ...applied.moved,
    ];
    const stuck =
      applied.stuck.length > 0
        ? `\n${applied.stuck.length} file(s) could not be deleted and stay, with their rows: ` +
          `${applied.stuck.slice(0, 5).join(', ')}.`
        : '';
    return ok(`${said}${stuck}`, {
      written,
      data: { removed: applied.moved, stuck: applied.stuck },
    });
  },
};

export { collectUnusedAssetsTool };
