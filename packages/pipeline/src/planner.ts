import type {
  AnyTask,
  Asset,
  BaseAssets,
  Logger,
  PagePanel,
  PanelBox,
  ProductionData,
  ProjectModel,
  RefBinding,
  Scene,
  Shot,
  TaskGraph,
  TaskInputs,
} from '@vn/types';
import { defectReportSchema, shotsOf } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { Providers } from '@vn/types';
import { contract } from '@vn/contracts';
import { liveScenes } from '@vn/model';
import { type ProjectPaths, productionOf, readShots, writeShots } from '@vn/store';
import { makeTask } from '@vn/taskgraph';
import { projectRefusal, solve, unitGates } from '@vn/constraint-solver';
import { cycleRefusal, firstCycle, layoutDefect, proseHash } from '@vn/stills';
import { VnError } from '@vn/util';
import { checkRequest } from '@vn/providers';
import { MODEL_SHEET_ANGLES } from './prompts.js';
import { decomposeScene, storyboardStyle, type StoryboardStyle } from './p5.js';
import { waveFacts } from './facts.js';
import { familyOf } from './workflows.js';

/** Model-sheet angles generated per outfit once a character is approved (report §P4). */
export { MODEL_SHEET_ANGLES };

/**
 * A scene's storyboard. Returns the persisted decomposition if one exists. Otherwise decomposes
 * the scene and writes the result out immediately. Re-decomposing over an existing file is never
 * done: the LLM path is non-deterministic, so it would change shot ids, hence task identities,
 * hence regenerate art.
 */
async function shotsFor(
  scene: Scene,
  model: ProjectModel,
  providers: Providers,
  style: StoryboardStyle,
  paths?: ProjectPaths,
  logger?: Logger,
  readOnly = false,
): Promise<ProductionData> {
  if (paths) {
    const known = new Set(scene.lines.map((l) => l.id));
    const loaded = await readShots(paths, scene.id, known);
    if (loaded) {
      for (const d of loaded.dropped) {
        logger?.warn('shot covers lines the screenplay no longer has; dropped', {
          scene: scene.id,
          shot : d.shotId,
          lines: d.lineIds,
        });
      }
      for (const u of loaded.unpanelled) {
        logger?.warn('line_in_no_panel: a page covers lines no panel letters', {
          scene: scene.id,
          shot : u.shotId,
          lines: u.lineIds,
        });
      }
      return productionOf(loaded);
    }
  }
  const decomposition = await decomposeScene(scene, model, providers, style);
  checkRequest();
  // Inside a run a baseline decomposition means the deterministic fallback worked, so it is still
  // written. Persisting one silently is how a whole project ends up baselined forever, so it is
  // logged here; `decomposeAll` refuses to write it at all.
  if (decomposition.source === 'baseline') {
    logger?.warn('decomposition fell back to the deterministic storyboard', {
      scene : scene.id,
      reason: decomposition.reason,
    });
  }
  if (paths && !readOnly) {
    await writeShots(paths, scene.id, decomposition.shots, { sheets: decomposition.sheets });
  }
  return {
    shots: decomposition.shots,
    ...(decomposition.sheets ? { sheets: decomposition.sheets } : {}),
  };
}

/**
 * Copy what the run produced onto the in-memory shot. The task graph is the authority, so a
 * shots file restored from an old commit cannot convince anything that work is done — the
 * stale values it loaded are overwritten here.
 *
 * `proseHash` is a deliberate exception: it is stamped only when these bytes are new. A rerun
 * reporting the same image must not re-baseline the prose under it, or a drift the author has
 * not acted on would be silently cleared by a run that did no work.
 *
 * `panelBoxes` follows the same rule: written with new bytes, from the attempt that produced
 * them, and left alone otherwise.
 */
function refreshShotData(shot: Shot, task: AnyTask, scene: Scene): void {
  const before = shot.image;
  const stamp = (): void => {
    if (shot.image === undefined || shot.image === before) return;
    shot.proseHash = proseHash(scene, shot.coversLines);
    const boxes = observedBoxes(task, shot.image, shot.panels);
    if (boxes) shot.panelBoxes = boxes;
    else delete shot.panelBoxes;
  };
  if (task.status === 'done' && task.output) {
    shot.image = task.output;
    stamp();
    return;
  }
  if (task.status === 'needs_human') {
    const last = task.attempts[task.attempts.length - 1]?.output;
    if (last) shot.image = last;
    stamp();
    return;
  }
  delete shot.image;
  // No image, so nothing the hash could describe; `serialize` would drop it anyway.
  delete shot.proseHash;
  delete shot.panelBoxes;
}

/**
 * The panel boxes a reviewer saw in `image`, from the attempt that drew it: the measurement that
 * matched the intended `panels` when one did (the runner's verdict trusts any reviewer's match),
 * else the first. Reviews are recorded loosely typed on the attempt, so the shape is checked here
 * rather than trusted.
 */
function observedBoxes(
  task: AnyTask,
  image: string,
  panels: readonly PagePanel[] | undefined,
): PanelBox[] | undefined {
  const attempt = task.attempts.find((a) => a.output === image);
  const measured: PanelBox[][] = [];
  for (const review of attempt?.reviews ?? []) {
    const parsed = defectReportSchema.safeParse(review);
    if (parsed.success && parsed.data.observed)
      measured.push(parsed.data.observed.panels.map((p) => p.box));
  }
  const matched = panels && measured.find((boxes) => layoutDefect(panels, boxes) === undefined);
  return matched ?? measured[0];
}

type ShotSlot = Extract<RefBinding, { kind: 'shot' }>;

/**
 * Copies a planned shot's prompt and its task's outcome onto the model's own shot, found by id,
 * so that `writeShots` persists them.
 */
function stampShot(
  model: ProjectModel,
  slot: ShotSlot,
  inputs: TaskInputs['shot_image'],
  node: AnyTask,
): void {
  const scene = model.scenes.get(slot.sceneId);
  const shot = shotsOf(model, slot.sceneId).find((s) => s.id === slot.shotId);
  if (!scene || !shot) return;
  shot.prompt = inputs.prompt;
  refreshShotData(shot, node, scene);
}

export const planningIncremental = contract({
  id      : 'planning.incremental',
  rule: '`planTasks` runs once per scheduler wave. It decomposes the owed scenes whose unit gate is open, solves the stills family, and adds the task of every slot the solver reports `ready`. It keeps no enumeration and no gate of its own.',
  prevents:
    'Planning a shot before its plate is drawn, when its identity cannot be stated yet, or a planner that enumerates pictures its own way and so plans work the slot graph does not show.',
  subjects: [
    'module:packages/pipeline/src/planner.ts',
    'function:packages/pipeline/src/planner.ts#planTasks',
    'function:packages/stills/src/family.ts#stillsFamily',
    'function:packages/stills/src/slotgraph.ts#planSlot',
    'function:packages/constraint-solver/src/solve.ts#solve',
  ],
  see: [
    'docs/reference/contracts.md#the-constraint-solver',
  ],
  detail:
    'A task whose inputs embed an upstream output (a shot embeds its plate and its sheets) has no ' +
    'identity until that upstream task is `done`, so it appears a wave later. `vngen cost` ' +
    'therefore counts only what is plannable when it runs, and undercounts the tasks a finished ' +
    "wave makes plannable. A task's `deps` come from its kind (`planSlot`: a shot's plate and " +
    'non-default sheets, never a portrait), and `Task.deps` is not hashed. The gate is ' +
    '`gate.perUnit`: the planner asks `unitGates` before decomposing and reads `ready` after.',
});

/**
 * Adds the tasks that are runnable now, given the model's approval state, and answers them
 * (report §5, §7, §P3 gate-as-barrier). See {@link planningIncremental}.
 *
 * Decomposes scenes lazily the first time a scene clears the gate, putting each storyboard into
 * `model.production`; the model is expected to hold only the storyboards earlier passes put there.
 *
 * With `paths`, decompositions are persisted under `work/shots/` and preferred over
 * re-decomposing; without it planning is pure, which is what the unit tests want.
 *
 * A project the solver refuses (`projectRefusal`, an `unavailable` base root) plans nothing.
 */
export async function planTasks(opts: {
  model: ProjectModel;
  graph: TaskGraph;
  config: ProjectConfig;
  providers: Providers;
  /** Enables shot persistence. Omit to plan without touching disk. */
  paths?: ProjectPaths;
  logger?: Logger;
  /** The store's base root, when the caller has one. Absent means "no opinion" — plan normally. */
  base?: BaseAssets;
  /**
   * Read persisted shots but never write. A dry run plans with mock providers, and a mock
   * decomposition must not be left behind for a later real run to reuse.
   */
  readOnlyShots?: boolean;
  /**
   * The manifest, which a staging sheet's references resolve from and the character gate reads.
   * Without it a sheet is keyed on its prompt and the portraits alone, and the gate reads the
   * sheet's mirror of the row, which is what a plan with no store can know.
   */
  assets?: readonly Asset[];
}): Promise<AnyTask[]> {
  const { model, graph, config, providers, paths, logger, base, readOnlyShots } = opts;
  // Built again after decomposing, because the kinds memoise on the facts object
  const facts = () => waveFacts({ model, config, tasks: graph, assets: opts.assets, base });
  const before = facts();
  const refusal = projectRefusal(before);
  if (refusal) {
    logger?.error('plan.refused', { reason: refusal, root: base?.root });
    return [];
  }

  const family = familyOf(config.workflow);
  // Storyboards first, so the solve below sees the shot slots of every scene the gate lets through
  const owed = family.owed(before);
  const gates = owed.length ? unitGates(family, before) : undefined;
  for (const sceneId of owed) {
    const scene = model.scenes.get(sceneId);
    if (!scene || !gates?.get(sceneId)?.open) continue;
    const storyboard = await shotsFor(
      scene,
      model,
      providers,
      storyboardStyle(config),
      paths,
      logger,
      readOnlyShots,
    );
    model.production.set(sceneId, storyboard);
  }

  const planned: AnyTask[] = [];
  const solved = solve(family, facts());
  for (const state of solved.slots.values()) {
    if (!state.ready || state.inputs === undefined) continue;
    const node = graph.add(makeTask(state.task, state.inputs, [...state.deps]));
    planned.push(node);
    if (state.task === 'shot_image')
      stampShot(model, state.binding as ShotSlot, state.inputs as TaskInputs['shot_image'], node);
  }

  // Written once per pass, including the final pass the scheduler runs after the last wave.
  // That final pass is what gets a completed run's outputs into the file.
  if (paths && !readOnlyShots) {
    for (const scene of liveScenes(model))
      if (solved.units.get(scene.id)?.open)
        await writeShots(paths, scene.id, shotsOf(model, scene.id));
  }

  // The defensive half of §14: `prompt.addRef` refuses a cycle before it can be written, so a
  // cycle here means a hand-edited project. Throwing is deliberate — a reference loop leaves every
  // task in it permanently unplannable, and the plan-run-replan loop would starve silently.
  const cycle = firstCycle({ model });
  if (cycle) throw new VnError('REF_CYCLE', cycleRefusal(cycle));

  return planned;
}
