import type {
  AnyTask,
  AssetKind,
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
import { supersededBy } from '@vn/artgen';
import { refinePrompt } from './p6.js';
import { shotSpec } from './prompts.js';
import type { RunDeps } from './pipeline.js';

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
  meta: Omit<AssetMeta, 'prompt' | 'refs' | 'modelId'>,
): Promise<AssetRef> {
  const result = await deps.providers.image.generate(prompt, refs, params);
  return deps.store.write(result.bytes, result.ext, {
    ...meta,
    prompt,
    refs: refs.map((r) => r.hash),
    modelId: result.modelId,
  });
}

const runLocationRef: Runner<'location_ref'> = async (task, deps) => {
  const { locationId, variant, prompt, refs, params } = task.inputs;
  const ref = await generateAsset(deps, prompt, refs, params, {
    kind: 'location_ref',
    sourceTask: task.hash,
    satisfies: { locationId, variant },
  });
  return { status: 'done', output: ref.hash };
};

const runPortrait: Runner<'portrait'> = async (task, deps) => {
  const { characterId, prompt, refs, params } = task.inputs;
  const ref = await generateAsset(deps, prompt, refs, params, {
    kind: 'portrait',
    sourceTask: task.hash,
    satisfies: { characterId },
  });
  // The portrait is a candidate; it is not accepted until a human approves it (§P3 gate).
  return { status: 'done', output: ref.hash };
};

const runModelSheet: Runner<'model_sheet'> = async (task, deps) => {
  const { characterId, outfit, prompt, refs, params } = task.inputs;
  // Model sheets are reference-guided edits of the approved portrait (first ref).
  const base = refs[0];
  const result = base
    ? await deps.providers.image.edit(base, prompt, refs.slice(1), params)
    : await deps.providers.image.generate(prompt, refs, params);
  const ref = await deps.store.write(result.bytes, result.ext, {
    kind: 'model_sheet',
    sourceTask: task.hash,
    prompt,
    refs: refs.map((r) => r.hash),
    modelId: result.modelId,
    satisfies: { characterId, outfit },
  });
  return { status: 'done', output: ref.hash };
};

/**
 * P7 generate → critique → refine loop (report §P7), folded into the shot runner so every
 * attempt is recorded on the task for provenance. Each attempt: generate the image, have
 * every vision reviewer critique it against the shot spec, merge the verdicts. A clean (no
 * blocking defects) result is accepted. A blocking result triggers a deterministic prompt
 * refinement and another attempt, up to `config.max_refine_attempts`; after that the shot
 * is flagged `needs_human` rather than silently shipping a flawed frame. The loop also gives up
 * early when a refinement changes nothing.
 */
function makeShotRunner(config: ProjectConfig): Runner<'shot_image'> {
  return async (task, deps) => {
    const found = findShot(deps, task.inputs.shotId);
    const spec: ShotSpec = found
      ? shotSpec(found.shot, found.scene, deps.model)
      : { description: task.inputs.prompt, characters: [], location: '' };
    const refs = task.inputs.refs;
    const maxAttempts = Math.max(1, config.max_refine_attempts);

    let prompt = task.inputs.prompt;
    let lastRef: AssetRef | undefined;
    let stalledAfter: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await deps.providers.image.generate(prompt, refs, task.inputs.params);
      const ref = await deps.store.write(result.bytes, result.ext, {
        kind: 'shot_image' satisfies AssetKind,
        sourceTask: task.hash,
        prompt,
        refs: refs.map((r) => r.hash),
        modelId: result.modelId,
        satisfies: found ? { sceneId: found.scene.id, shotId: found.shot.id } : {},
      });
      lastRef = ref;

      const reports: DefectReport[] = await Promise.all(
        deps.providers.reviewers.map((r) => r.review(ref, spec, refs)),
      );
      const merged = mergeReports(reports);

      const record: TaskAttempt = {
        attempt,
        prompt,
        refs: refs.map((r) => r.hash),
        output: ref.hash,
        reviews: reports,
        at: deps.now?.(),
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

      // Blocking defects: refine the prompt from the merged critique and try again.
      const refined = refinePrompt(prompt, merged.defects);
      // Refinement is deterministic, so an unchanged prompt means the reviewers returned the same
      // critique and the next attempt would issue the identical request. `needs_human` is the
      // outcome for a critique that repeats unchanged.
      if (refined === prompt) {
        stalledAfter = attempt;
        break;
      }
      prompt = refined;
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
        error: `no runner for task kind "${kind}" (${task.hash})`,
      });
  return {
    location_ref: runLocationRef as Runner,
    portrait: runPortrait as Runner,
    model_sheet: runModelSheet as Runner,
    shot_image: shot as Runner,
    // P7 review/refine are folded into shot_image; these kinds are reserved (report deviation).
    outfit_sheet: unsupported('outfit_sheet'),
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
