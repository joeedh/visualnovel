import { setSceneOutfit, wardrobesOf, type BranchOp, type SceneOutfitOp } from '@vn/scriptedit';
import { applyMarkerPlan, planMarkerEdit } from '@vn/scriptedit/write';
import type { Scene } from '@vn/types';
import type { BranchEditResult, StoryGraph } from '../../../shared/ipc.js';
import { storyGraphOf } from '../../doctree/storygraph.js';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject } from '../load/project.js';
import { relPath } from '../load/tree.js';

export async function storyGraph(session: WorkspaceSession): Promise<StoryGraph> {
  const project = await loadProject(session.dir);
  return storyGraphOf(project.model);
}

/**
 * The single write path for every `story.*` edit: decide the rewire against the freshly
 * loaded scenes, patch the branch markers in whichever file each scene lives in, write
 * atomically, and rebuild the model. `decide` is passed in rather than the edits themselves
 * so the decision and the patch see the same load — a scene list read a moment earlier could
 * already be stale.
 *
 * Rebuilding is not optional: reachability changes with the wiring, and a stale `reachable`
 * set would draw live scenes as dead.
 */
export async function editBranches(
  session: WorkspaceSession,
  decide: (scenes: Map<string, Scene>) => BranchOp,
): Promise<BranchEditResult> {
  const project = await loadProject(session.dir);
  const op = decide(project.model.scenes);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  const plan = planMarkerEdit(project.sources, op.edits);
  if (!plan.ok) return { ok: false, message: plan.message, written: [] };

  if (plan.patches.length === 0) {
    return {
      ok     : true,
      message: `${op.message} (already wired that way — nothing written)`,
      written: [],
      graph  : storyGraphOf(project.model),
    };
  }

  const files = await applyMarkerPlan(plan.patches);
  const reloaded = await loadProject(session.dir);
  return {
    ok     : true,
    message: op.message,
    written: files.map((file) => relPath(session.dir, file)),
    graph  : storyGraphOf(reloaded.model),
  };
}

/**
 * The scene-marker outfit rule against a fresh load: the wardrobes it is checked against and the
 * scenes it would be decided over, from the same read. `decide` is handed to `editBranches`
 * rather than run here, so the patch sees the scenes the rule saw.
 */
async function sceneOutfitRule(
  session: WorkspaceSession,
  sceneId: string,
  character: string,
  outfit: string,
): Promise<{
  project: LoadedProject;
  decide: (scenes: Map<string, Scene>) => SceneOutfitOp;
}> {
  const project = await loadProject(session.dir);
  const wardrobes = wardrobesOf(project.model.characters);
  return {
    project,
    decide: (scenes) => setSceneOutfit(scenes, wardrobes, { scene: sceneId, character, outfit }),
  };
}

/** The decision behind `story.setSceneOutfit`, curried for `editBranches` like `shotOrder`. */
export async function sceneOutfit(
  session: WorkspaceSession,
  sceneId: string,
  character: string,
  outfit: string,
): Promise<(scenes: Map<string, Scene>) => SceneOutfitOp> {
  return (await sceneOutfitRule(session, sceneId, character, outfit)).decide;
}

/**
 * What `story.setSceneOutfit` would do, decided without writing. It does not preview against
 * the story graph the other branch checks use: that projection carries edges and reachability,
 * and the outfit markers this rule needs are not in it.
 */
export async function previewSceneOutfit(
  session: WorkspaceSession,
  sceneId: string,
  character: string,
  outfit: string,
): Promise<SceneOutfitOp> {
  const { project, decide } = await sceneOutfitRule(session, sceneId, character, outfit);
  return decide(project.model.scenes);
}
