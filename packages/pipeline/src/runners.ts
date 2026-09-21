import type {
  AnyTask,
  AssetMeta,
  AssetRef,
  DefectReport,
  ImageParams,
  ReviewRef,
  Scene,
  Shot,
  ShotSpec,
  Task,
  TaskAttempt,
  TaskKind,
  TaskResult,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { mergeReports, reportingRetries } from '@vn/providers';
import { heldBy, layoutDefect, sheetSeeds } from '@vn/artgen';
import type { SheetSeeds } from '@vn/artgen';
import { refinePrompt } from './p6.js';
import { shotSpec } from './prompts.js';
import {
  boundGraph,
  readDrawn,
  refinesThroughNode,
  runBoundGraph,
  storeGraphImage,
} from './graphrun.js';
import type { GraphBinding, GraphDraw, GraphRunOptions } from './graphrun.js';
import type { RunDeps } from './pipeline.js';

/** The type names of the two nodes a staging sheet is seeded through. */
const SHEET_PROMPT = 'GenSheetPrompt';
const SHEET_REFS = 'GenSheetRefs';

/** The half of an asset's metadata a runner knows before the picture exists. */
type AssetWriteMeta = Omit<AssetMeta, 'prompt' | 'refs' | 'modelId'>;

/** A per-kind task runner: execute one node and report its outcome (report §5). */
export type Runner<K extends TaskKind = TaskKind> = (
  task: Task<K>,
  deps: RunDeps,
) => Promise<TaskResult>;

/** Locate a decomposed shot (and its scene) by the namespaced shot id. */
function findShot(deps: RunDeps, shotId: string): { shot: Shot; scene: Scene } | undefined {
  for (const scene of deps.model.scenes.values()) {
    const shot = scene.shots.find((s) => s.id === shotId);
    if (shot) return { shot, scene };
  }
  return undefined;
}

/** Generate one image and persist it; returns the stored asset ref. */
async function generateAsset(
  deps: RunDeps,
  prompt: string,
  refs: AssetRef[],
  params: ImageParams,
  meta: AssetWriteMeta,
): Promise<AssetRef> {
  const result = await deps.providers.image.generate(prompt, refs, params);
  return deps.store.write(result.bytes, result.ext, {
    ...meta,
    prompt,
    refs   : refs.map((r) => r.hash),
    modelId: result.modelId,
    ...(result.transport === undefined ? {} : { transport: result.transport }),
  });
}

/**
 * Makes a picture the take its slot holds, releasing the takes it replaces, and records the
 * attempt that drew it. The row's `via` says a run drew it; `at` is the run's clock. The manifest
 * alone decides what is released, because a runner has no task graph: a sheet row's angle is on
 * its binding for exactly this reason.
 */
async function fileTake(
  deps: RunDeps,
  task: AnyTask,
  ref: AssetRef,
  prompt: string,
  refs: AssetRef[],
): Promise<void> {
  const at = deps.now?.();
  task.attempts.push({
    attempt: task.attempts.length + 1,
    prompt,
    refs  : refs.map((r) => r.hash),
    output: ref.hash,
    ...(at === undefined ? {} : { at }),
    via: 'run',
  });
  await holdTake(deps, ref, at);
}

/** The hold alone, for the shot runner, which records its attempts itself. */
async function holdTake(deps: RunDeps, ref: AssetRef, at: string | undefined): Promise<void> {
  const assets = deps.store.manifest();
  const asset = assets.find((a) => a.hash === ref.hash);
  if (!asset) return;
  await deps.store.hold(ref.hash, heldBy(asset, { model: deps.model, assets }), {
    ...(at === undefined ? {} : { at }),
    via: 'run',
  });
}

/**
 * One picture drawn through the graph bound to the task's slot. The graph's own image nodes
 * carry the aspect and seed an unbound task takes from `task.inputs.params`, which is why
 * the parameters are not passed on: the node is where an author sets them. Answers the stored
 * asset and what the graph reported drawing it from, which a sheet member's review reads.
 */
async function drawThroughGraph(
  deps: RunDeps,
  binding: GraphBinding,
  prompt: string,
  refs: AssetRef[],
  meta: AssetWriteMeta,
  extra: Pick<GraphRunOptions, 'critique' | 'seeds'> = {},
): Promise<{ ref: AssetRef; draw: GraphDraw }> {
  const draw = await runBoundGraph(deps, binding, { prompt, refs, ...extra });
  const ref = await storeGraphImage(deps, binding, draw, { prompt, refs }, meta);
  return { ref, draw };
}

/**
 * What a staging sheet's graph is seeded with for this shot: the group's prompt and references,
 * derived from the project as the planner derived the member's key. A shot in no group, or one
 * whose group the scene no longer has, seeds nothing, and the graph's sheet nodes carry empty
 * values.
 */
function sheetSeedsFor(
  found: { shot: Shot; scene: Scene } | undefined,
  deps: RunDeps,
  config: ProjectConfig,
): SheetSeeds | undefined {
  if (found?.shot.sheet === undefined) return undefined;
  return sheetSeeds(found.scene, found.shot.sheet, deps.model, config, deps.store.manifest());
}

function graphSeedsOf(seeds: SheetSeeds | undefined): Pick<GraphRunOptions, 'seeds'> {
  if (!seeds) return {};
  return {
    seeds: {
      [SHEET_PROMPT]: { prompt: seeds.prompt },
      [SHEET_REFS]  : { assets: JSON.stringify(seeds.refs) },
    },
  };
}

/**
 * The sentence a sheet member's reviewer reads, naming the cell the frame was cut from and the
 * pictures that follow the task's own references: the cell, then the whole sheet.
 */
export function sheetReviewNote(seeds: SheetSeeds, shotId: string): string {
  const cell = seeds.members.findIndex((m) => m.id === shotId) + 1;
  return (
    `This frame was drawn from cell ${cell} of a ${seeds.members.length}-cell staging sheet of ` +
    'the scene, and that cell is the last reference. The frame must be one picture, never a ' +
    "grid of several, and its room and furniture must be the cell's; either failing is a " +
    'blocking defect in category "staging". The cell’s camera and staging are guidance: a ' +
    'frame that follows the shot specification more closely than the cell does is not defective.'
  );
}

/**
 * The pictures the graph drew the frame from that the reviewers cannot read as assets: the
 * intermediates a bound graph wrote as blobs, such as a sheet cell and the sheet. Read into
 * bytes here, because a reviewer loads assets and nothing else by reference.
 */
async function graphReviewRefs(binding: GraphBinding, draw: GraphDraw): Promise<ReviewRef[]> {
  const out: ReviewRef[] = [];
  for (const ref of draw.refs) {
    if (ref.store !== 'blob') continue;
    out.push({ bytes: await readDrawn(binding.services, ref), ext: ref.ext });
  }
  return out;
}

const runLocationRef: Runner<'location_ref'> = async (task, deps) => {
  const { locationId, variant, prompt, refs, params } = task.inputs;
  const meta: AssetWriteMeta = {
    kind      : 'location_ref',
    sourceTask: task.hash,
    satisfies : { locationId, variant },
  };
  const binding = boundGraph(task, deps);
  const ref = binding
    ? (await drawThroughGraph(deps, binding, prompt, refs, meta)).ref
    : await generateAsset(deps, prompt, refs, params, meta);
  await fileTake(deps, task, ref, prompt, refs);
  return { status: 'done', output: ref.hash };
};

const runPortrait: Runner<'portrait'> = async (task, deps) => {
  const { characterId, prompt, refs, params } = task.inputs;
  const meta: AssetWriteMeta = {
    kind      : 'portrait',
    sourceTask: task.hash,
    satisfies : { characterId },
  };
  const binding = boundGraph(task, deps);
  const ref = binding
    ? (await drawThroughGraph(deps, binding, prompt, refs, meta)).ref
    : await generateAsset(deps, prompt, refs, params, meta);
  // The portrait is held as the slot's take, and the gate still decides approval (§P3)
  await fileTake(deps, task, ref, prompt, refs);
  return { status: 'done', output: ref.hash };
};

const runModelSheet: Runner<'model_sheet'> = async (task, deps) => {
  const { characterId, outfit, prompt, refs, params } = task.inputs;
  const meta: AssetWriteMeta = {
    kind      : 'model_sheet',
    sourceTask: task.hash,
    satisfies : { characterId, outfit, angle: task.inputs.angle },
  };

  const binding = boundGraph(task, deps);
  if (binding) {
    const { ref } = await drawThroughGraph(deps, binding, prompt, refs, meta);
    await fileTake(deps, task, ref, prompt, refs);
    return { status: 'done', output: ref.hash };
  }

  // Model sheets are reference-guided edits of the approved portrait (first ref).
  const base = refs[0];
  const result = base
    ? await deps.providers.image.edit(base, prompt, refs.slice(1), params)
    : await deps.providers.image.generate(prompt, refs, params);
  const ref = await deps.store.write(result.bytes, result.ext, {
    ...meta,
    prompt,
    refs   : refs.map((r) => r.hash),
    modelId: result.modelId,
    ...(result.transport === undefined ? {} : { transport: result.transport }),
  });
  await fileTake(deps, task, ref, prompt, refs);
  return { status: 'done', output: ref.hash };
};

/**
 * The layout verdict on a page, as one more report beside the reviewers': every measuring
 * reviewer's boxes matched to the intended panels, and the page honoured when any of them match.
 * A reviewer's measurement can be off (the Stage 2 live check caught one scaling a page by its
 * width) while none invents well-matched boxes for a wrong layout, so a match from any reviewer
 * is trusted and the defect names the first reviewer's miss. A page no reviewer measured gets no
 * verdict, so a reviewer that answers nothing about panels cannot block every page.
 */
export function layoutReport(
  shot: Shot | undefined,
  reports: readonly DefectReport[],
): DefectReport[] {
  if (!shot?.panels) return [];
  const measured = reports.flatMap((r) =>
    r.observed ? [r.observed.panels.map((p) => p.box)] : [],
  );
  if (measured.length === 0) return [];
  const defects = measured.map((boxes) => layoutDefect(shot.panels!, boxes));
  const first = defects.find((d) => d !== undefined);
  const honoured = defects.some((d) => d === undefined);
  return [{ reviewer: 'layout', defects: honoured || !first ? [] : [first] }];
}

/**
 * P7 generate → critique → refine loop (report §P7), folded into the shot runner so every
 * attempt is recorded on the task for provenance. Each attempt: generate the image, have
 * every vision reviewer critique it against the shot spec, merge the verdicts. A clean (no
 * blocking defects) result is accepted. A blocking result triggers a deterministic prompt
 * refinement and another attempt, up to `config.max_refine_attempts`; after that the shot
 * is flagged `needs_human` rather than silently shipping a flawed frame. The loop also gives up
 * early when a refinement repeats one the task has already tried, at any distance back: a
 * bound graph resumes the picture that critique produced rather than drawing a new one, so
 * the reviewers would answer as they did then and the loop would only spend their calls.
 */
function makeShotRunner(config: ProjectConfig): Runner<'shot_image'> {
  return async (task, deps) => {
    const found = findShot(deps, task.inputs.shotId);
    const spec: ShotSpec = found
      ? shotSpec(found.shot, found.scene, deps.model, config.lettering)
      : { description: task.inputs.prompt, characters: [], location: '' };
    const refs = task.inputs.refs;
    const sheet = sheetSeedsFor(found, deps, config);
    if (sheet && found) {
      spec.description = `${spec.description} ${sheetReviewNote(sheet, found.shot.id)}`;
    }
    const maxAttempts = Math.max(1, config.max_refine_attempts);
    const meta: AssetWriteMeta = {
      kind      : 'shot_image',
      sourceTask: task.hash,
      satisfies : found ? { sceneId: found.scene.id, shotId: found.shot.id } : {},
    };
    const binding = boundGraph(task, deps);
    // A critique re-enters a bound graph through its refine node, which changes that node's
    // hash and so re-runs only the tail. A graph with none takes it on the derived prompt.
    const throughNode = binding !== undefined && refinesThroughNode(binding.graph);

    let prompt = task.inputs.prompt;
    let critique = '';
    let lastRef: AssetRef | undefined;
    let stalledAfter: number | undefined;
    // What every attempt so far was drawn from: the critique on the bound path, the prompt otherwise
    const tried = new Set<string>();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      tried.add(throughNode ? critique : prompt);
      const stage = maxAttempts > 1 ? `attempt ${attempt} of ${maxAttempts}: ` : '';
      deps.activity?.(task, `${stage}drawing`);
      let ref: AssetRef;
      let shown: ReviewRef[] = refs;
      if (binding) {
        const drawn = await drawThroughGraph(deps, binding, prompt, refs, meta, {
          critique,
          ...graphSeedsOf(sheet),
        });
        ref = drawn.ref;
        if (sheet) shown = [...refs, ...(await graphReviewRefs(binding, drawn.draw))];
      } else {
        ref = await generateAsset(deps, prompt, refs, task.inputs.params, meta);
      }
      lastRef = ref;

      deps.activity?.(task, `${stage}reviewing`);
      const reviewed: DefectReport[] = await Promise.all(
        deps.providers.reviewers.map((r) => r.review(ref, spec, shown)),
      );
      const reports = [...reviewed, ...layoutReport(found?.shot, reviewed)];
      const merged = mergeReports(reports);

      const at = deps.now?.();
      const record: TaskAttempt = {
        attempt,
        prompt,
        refs   : refs.map((r) => r.hash),
        output : ref.hash,
        reviews: reports,
        ...(at === undefined ? {} : { at }),
        via: 'run',
      };
      task.attempts.push(record);

      if (!merged.blocking) {
        // The clean frame is the take the slot holds; the reviewers' verdict gates retries and
        // approves nothing, which stays a person's act
        await holdTake(deps, ref, at);
        if (found) found.shot.status = 'accepted';
        return { status: 'done', output: ref.hash };
      }

      // Blocking defects: refine from the merged critique and try again. Refinement is
      // deterministic, so text an earlier attempt already tried means the reviewers are going
      // in circles and the next attempt would repeat a request already made. `needs_human` is
      // the outcome for a critique that repeats.
      const next = throughNode
        ? refinePrompt('', merged.defects).trim()
        : refinePrompt(prompt, merged.defects);
      if (tried.has(next)) {
        stalledAfter = attempt;
        break;
      }
      if (throughNode) {
        critique = next;
      } else {
        prompt = next;
      }
    }

    // The flawed frame holds the slot too: it is what the author needs to see and fix
    if (lastRef) await holdTake(deps, lastRef, deps.now?.());
    if (found) found.shot.status = 'needs_human';
    return {
      status: 'needs_human',
      output: lastRef?.hash,
      error: stalledAfter
        ? `shot still has blocking defects after ${stalledAfter} attempts; the critique repeated unchanged, so refining again would repeat the same request`
        : `shot still has blocking defects after ${maxAttempts} attempts`,
    };
  };
}

/** Build the per-kind runner registry bound to the project config (for the P7 cap). */
export function createRunners(config: ProjectConfig): Record<TaskKind, Runner> {
  const shot = makeShotRunner(config);
  const unsupported =
    (kind: TaskKind): Runner =>
    (task) =>
      Promise.resolve({
        status: 'failed',
        error : `no runner for task kind "${kind}" (${task.hash})`,
      });
  return {
    location_ref : runLocationRef as Runner,
    portrait     : runPortrait as Runner,
    model_sheet  : runModelSheet as Runner,
    shot_image   : shot as Runner,
    // P7 review/refine are folded into shot_image; these kinds are reserved (report deviation).
    outfit_sheet : unsupported('outfit_sheet'),
    vision_review: unsupported('vision_review'),
    prompt_refine: unsupported('prompt_refine'),
  };
}

/**
 * Dispatch a task to its kind's runner. A retry a provider call makes underneath is reported as
 * the task's activity, since the runner cannot see it and it is the wait an author most wants
 * explained.
 */
export function runTask(
  task: AnyTask,
  deps: RunDeps,
  runners: Record<TaskKind, Runner>,
): Promise<TaskResult> {
  deps.activity?.(task, 'drawing');
  const run = () => runners[task.kind](task, deps);
  const { activity } = deps;
  return activity ? reportingRetries((note) => activity(task, note), run) : run();
}
