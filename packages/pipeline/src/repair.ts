/**
 * Manifest repair before a run or a read: a slot holding more than one accepted take is put
 * back to one, so the slot resolves again. Idempotent, and a clean manifest is not written.
 */
import { lastRenderedAt, overAccepted, type OverAccepted } from '@vn/artgen';
import type { AssetStore, Logger, ProjectModel, Shot, TaskGraph } from '@vn/types';

export interface RepairDeps {
  model: ProjectModel;
  store: AssetStore;
  graph: TaskGraph;
  logger?: Logger;
  /**
   * Each scene's persisted shots, read on demand: a shot slot keeps the take its storyboard names,
   * and the files are only opened when some slot needs putting right.
   */
  readShots?: () => Promise<ReadonlyMap<string, readonly Shot[] | null>>;
}

/**
 * Un-accepts every surplus take, one manifest write per slot, and reports what moved. The angle
 * of a sheet comes off its task, so a sheet is told apart from its siblings the way the planner
 * tells them apart.
 */
export async function repairAccepted(deps: RepairDeps): Promise<OverAccepted[]> {
  const ctx = {
    model     : deps.model,
    assets    : deps.store.manifest(),
    angleOf: (sourceTask: string | undefined) => {
      const task = sourceTask === undefined ? undefined : deps.graph.get(sourceTask);
      return task && 'angle' in task.inputs ? task.inputs.angle : undefined;
    },
    renderedAt: lastRenderedAt(deps.graph),
  };
  if (overAccepted(ctx).length === 0) return [];

  const shots = deps.readShots === undefined ? undefined : await deps.readShots();
  const fixes = overAccepted({ ...ctx, ...(shots === undefined ? {} : { shots }) });
  for (const fix of fixes) {
    await deps.store.accept(fix.keep, fix.drop);
    deps.logger?.info('manifest.repair', { slot: fix.slot, keep: fix.keep, drop: fix.drop });
  }
  return fixes;
}
