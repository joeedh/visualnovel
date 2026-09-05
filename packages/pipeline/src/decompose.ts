import type { Logger, ProjectModel, Providers } from '@vn/types';
import { reachableScenes } from '@vn/model';
import { readShots, writeShots, type ProjectPaths } from '@vn/store';
import { decomposeScene } from './p5.js';

/**
 * What a batch decomposition did, per scene. Four disjoint lists rather than a count, because each
 * list names scenes an author may need to act on.
 */
export interface DecomposeAllResult {
  /** Scenes whose storyboard the model wrote, now on disk. */
  decomposed: string[];
  /** Scenes that already had a file. Untouched, and no provider call was made for them. */
  kept: string[];
  /** The model did not answer. Nothing was written; see {@link decomposeAll}. */
  fellBack: { scene: string; reason: string }[];
  /** A file exists but would not parse. Left exactly as it is, and the batch carried on. */
  unreadable: { scene: string; error: string }[];
}

export interface DecomposeAllOptions {
  model: ProjectModel;
  providers: Providers;
  paths: ProjectPaths;
  logger?: Logger;
  /**
   * Write the deterministic storyboard when the model does not answer. Off by default and
   * deliberately hard to reach; see {@link decomposeAll} for why this is nearly always wrong.
   */
  keepBaseline?: boolean;
}

/**
 * Decompose every reachable scene that has no storyboard yet, so the project can see the whole
 * graph instead of one wave of it.
 *
 * Each rule guards a hazard the incremental path never had to face:
 *
 * - Reachable scenes only. A dead branch costs a model call and renders nothing.
 * - A scene that already has a file is kept, and there is no `force`. `work/shots/<sceneId>.json`
 *   wins forever; re-decomposing is non-deterministic, so it would change shot ids, hence task
 *   identities, hence re-render art that is already paid for. A file created by a hand-placed
 *   first shot (`story.newShot`, the agent's `write_storyboard`) is kept the same way, because
 *   writing it is how making shots by hand ends decomposition for a scene.
 * - A baseline is reported, not written. An absent file is the only signal that means
 *   "decompose this scene", so persisting a fallback is permanent. One scene inside a run is the
 *   deterministic-fallback contract working; sixty at once with one bad key would silently baseline
 *   an entire project with no way back short of deleting files by hand. `keepBaseline` exists for a
 *   caller that genuinely wants the deterministic storyboard, and nothing in the app passes it.
 * - One bad file does not stop the batch. `readShots` throws on a malformed file rather than
 *   re-decomposing over a hand-edit, so the throw is caught per scene and the scene is named.
 *
 * `writeShots` skips a byte-identical rewrite, so a second run over a decomposed project leaves the
 * worktree clean.
 */
export async function decomposeAll(opts: DecomposeAllOptions): Promise<DecomposeAllResult> {
  const { model, providers, paths, logger } = opts;
  const out: DecomposeAllResult = { decomposed: [], kept: [], fellBack: [], unreadable: [] };

  for (const scene of reachableScenes(model)) {
    try {
      // Unfiltered on purpose: this asks only whether a storyboard exists, and dropping stale
      // `coversLines` here would hide nothing and repair nothing.
      if (await readShots(paths, scene.id)) {
        out.kept.push(scene.id);
        continue;
      }
    } catch (err) {
      out.unreadable.push({
        scene: scene.id,
        error: err instanceof Error ? err.message : `${err}`,
      });
      continue;
    }

    const result = await decomposeScene(scene, model, providers);
    if (result.source === 'baseline' && !opts.keepBaseline) {
      out.fellBack.push({ scene: scene.id, reason: result.reason ?? 'the model did not answer' });
      logger?.warn('not writing a baseline storyboard', {
        scene : scene.id,
        reason: result.reason,
      });
      continue;
    }
    await writeShots(paths, scene.id, result.shots);
    out.decomposed.push(scene.id);
  }
  return out;
}

/**
 * What `decomposeAll` would do, without spending anything. This is the half of the answer that can
 * be had for free, since a command's `check` must never call the model, and it lets a confirmation
 * dialog say how many scenes it is about to pay for before the author agrees to it.
 *
 * `atRisk` is the one that is easy to miss: `resolveSubject` silently drops a `characterId` the
 * model does not have, and the decomposition is then permanent, so decomposing before the cast
 * sheets exist omits that character from every shot in the scene forever.
 */
export async function decomposeAllPreview(
  model: ProjectModel,
  paths: ProjectPaths,
): Promise<{ pending: string[]; kept: string[]; unreadable: string[]; atRisk: string[] }> {
  const pending: string[] = [];
  const kept: string[] = [];
  const unreadable: string[] = [];
  const warned = new Set(
    model.diagnostics.filter((d) => d.code === 'unknown_character').map((d) => d.where),
  );

  for (const scene of reachableScenes(model)) {
    try {
      if (await readShots(paths, scene.id)) kept.push(scene.id);
      else pending.push(scene.id);
    } catch {
      // Only the scene name is reported here; `decomposeAll` carries the error message
      unreadable.push(scene.id);
    }
  }
  return { pending, kept, unreadable, atRisk: pending.filter((id) => warned.has(id)) };
}
