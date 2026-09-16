import type {
  AnyTask,
  AssetMeta,
  AssetRef,
  DefectReport,
  ImageParams,
  Scene,
  Shot,
  ShotSpec,
  Task,
  TaskAttempt,
  TaskKind,
  TaskResult,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { mergeReports } from '@vn/providers';
import { layoutDefect, supersededBy } from '@vn/artgen';
import { refinePrompt } from './p6.js';
import { shotSpec } from './prompts.js';
import { boundGraph, refinesThroughNode, runBoundGraph, storeGraphImage } from './graphrun.js';
import type { GraphBinding } from './graphrun.js';
import type { RunDeps } from './pipeline.js';

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
  });
}

/**
 * One picture drawn through the graph bound to the task's slot. The graph's own image nodes
 * carry the aspect and seed an unbound task takes from `task.inputs.params`, which is why
 * the parameters are not passed on: the node is where an author sets them.
 */
async function drawThroughGraph(
  deps: RunDeps,
  binding: GraphBinding,
  prompt: string,
  refs: AssetRef[],
  meta: AssetWriteMeta,
  critique?: string,
): Promise<AssetRef> {
  const draw = await runBoundGraph(deps, binding, {
    prompt,
    refs,
    ...(critique === undefined ? {} : { critique }),
  });
  return storeGraphImage(deps, binding, draw, { prompt, refs }, meta);
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
    ? await drawThroughGraph(deps, binding, prompt, refs, meta)
    : await generateAsset(deps, prompt, refs, params, meta);
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
    ? await drawThroughGraph(deps, binding, prompt, refs, meta)
    : await generateAsset(deps, prompt, refs, params, meta);
  // The portrait is a candidate; it is not accepted until a human approves it (§P3 gate).
  return { status: 'done', output: ref.hash };
};

const runModelSheet: Runner<'model_sheet'> = async (task, deps) => {
  const { characterId, outfit, prompt, refs, params } = task.inputs;
  const meta: AssetWriteMeta = {
    kind      : 'model_sheet',
    sourceTask: task.hash,
    satisfies : { characterId, outfit },
  };

  const binding = boundGraph(task, deps);
  if (binding) {
    const ref = await drawThroughGraph(deps, binding, prompt, refs, meta);
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
  });
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
      const ref = binding
        ? await drawThroughGraph(deps, binding, prompt, refs, meta, critique)
        : await generateAsset(deps, prompt, refs, task.inputs.params, meta);
      lastRef = ref;

      const reviewed: DefectReport[] = await Promise.all(
        deps.providers.reviewers.map((r) => r.review(ref, spec, refs)),
      );
      const reports = [...reviewed, ...layoutReport(found?.shot, reviewed)];
      const merged = mergeReports(reports);

      const record: TaskAttempt = {
        attempt,
        prompt,
        refs   : refs.map((r) => r.hash),
        output : ref.hash,
        reviews: reports,
        at     : deps.now?.(),
      };
      task.attempts.push(record);

      if (!merged.blocking) {
        // Accepting the frame un-accepts the takes it replaces, including this task's own earlier
        // attempts and any frame an older task left for the same shot. Two accepted candidates make
        // the slot unresolvable, so the shot would read as unrendered and everything drawn from it
        // would re-render.
        const asset = deps.store.manifest().find((a) => a.hash === ref.hash);
        const supersede = asset
          ? supersededBy(asset, { model: deps.model, assets: deps.store.manifest() })
          : [];
        await deps.store.accept(ref.hash, supersede);
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

/** Dispatch a task to its kind's runner. */
export function runTask(
  task: AnyTask,
  deps: RunDeps,
  runners: Record<TaskKind, Runner>,
): Promise<TaskResult> {
  return runners[task.kind](task, deps);
}
