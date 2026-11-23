import { setStartScene } from '@vn/config';
import { assignLineIds } from '@vn/model';
import { readShots } from '@vn/store';
import { fileCache } from '../../workspace/filecache.js';
import { priceShotChanges } from '@vn/stills';
import {
  moveShot,
  type EntityOp,
  type EntityWorld,
  type LineOp,
  type ScriptState,
} from '@vn/scriptedit';
import {
  applyEntityPlan,
  applyScenePlan,
  entityPlanMessage,
  planEntityDelete,
  planSceneEdit,
  scenePlanMessage,
  scriptStateOf,
  type AppliedEntityPlan,
  type ScenePlan,
  type SceneSource,
  type ShotPrice,
} from '@vn/scriptedit/write';
import type { SceneEditResult } from '../../../shared/ipc.js';
import { storyGraphOf } from '../../doctree/storygraph.js';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, editInputOf, withShots, loadProject } from '../load/project.js';
import { relPath } from '../load/tree.js';

/**
 * The scenes a prose edit is decided against: as their chunks parse, with cues still the ones
 * the author typed — deliberately not the model's, which resolves each cue to a character id.
 * This is what an interaction's `targets` enumerates over; a command's own `check` goes through
 * `previewSceneEdit`, which decides against this same state and prices the storyboard too.
 */
export async function scriptState(session: WorkspaceSession): Promise<ScriptState> {
  const project = await loadProject(session.dir);
  return scriptStateOf(project.sources, project.config.start);
}

/**
 * A prose edit decided against a fresh load and not written — `@vn/scriptedit` owns the rules and
 * the proof; this is only the load. Shared by `previewSceneEdit` and `editScene`, so a `check`
 * reports the consequence the run produces rather than a description of one.
 */
async function planScene(
  session: WorkspaceSession,
  decide: (state: ScriptState) => LineOp,
): Promise<{ project: LoadedProject; plan: ScenePlan }> {
  const project = await loadProject(session.dir);
  return { project, plan: await planSceneEdit(editInputOf(project), decide) };
}

/** What `editScene` would do and cost the storyboard, without doing it. */
export async function previewSceneEdit(
  session: WorkspaceSession,
  decide: (state: ScriptState) => LineOp,
): Promise<{ ok: boolean; message: string }> {
  const { plan } = await planScene(session, decide);
  if (!plan.ok) return { ok: false, message: plan.message };
  return { ok: true, message: scenePlanMessage(plan) };
}

/**
 * Lists the files a prose edit would remove, workspace-relative: the chunks it ends and the
 * storyboards it empties.
 */
export async function sceneEditRemovals(
  session: WorkspaceSession,
  decide: (state: ScriptState) => LineOp,
): Promise<string[]> {
  const { project, plan } = await planScene(session, decide);
  if (!plan.ok) return [];
  return [
    ...plan.chunkRemoves.map((id) => project.paths.sceneFile(id)),
    ...plan.fallout.removes.map((id) => project.paths.shotsFile(id)),
  ].map((file) => relPath(session.dir, file));
}

/**
 * The single write path for every prose edit, and the sibling of `editBranches`: apply the proved
 * plan — chunks, storyboards, removals — then rebuild the model. The app's own part is reporting:
 * `applyScenePlan` answers in absolute paths, and a `written` list is workspace-relative.
 */
export async function editScene(
  session: WorkspaceSession,
  decide: (state: ScriptState) => LineOp,
): Promise<SceneEditResult> {
  const { project, plan } = await planScene(session, decide);
  if (!plan.ok) return { ok: false, message: plan.message, written: [], removed: [] };

  const input = editInputOf(project);
  const paths = await applyScenePlan(input, plan);
  const written = paths.written.map((file) => relPath(session.dir, file));
  if (plan.start !== undefined && (await setStartScene(session.dir, plan.start))) {
    written.push(relPath(session.dir, project.paths.projectConfig));
  }
  const removed = paths.removed.map((file) => relPath(session.dir, file));

  if (written.length === 0 && removed.length === 0) {
    return {
      ok     : true,
      message: `${plan.message} (already reads that way — nothing written)`,
      written: [],
      removed: [],
      graph  : storyGraphOf(project.model),
    };
  }
  const reloaded = await loadProject(session.dir);
  return {
    ok     : true,
    message: scenePlanMessage(plan),
    written,
    removed,
    graph: storyGraphOf(reloaded.model),
  };
}

/**
 * Decides and proves an entity delete against a fresh load, writing nothing, and prices the
 * shots it changes. Shared by `previewEntityDelete` and `deleteEntity`, so the listing a
 * check shows is the plan the run carries out.
 */
async function planEntity(
  session: WorkspaceSession,
  kind: 'character' | 'location',
  id: string,
  decide: (world: EntityWorld) => EntityOp,
): Promise<
  | { ok: false; message: string }
  | { ok: true; project: LoadedProject; plan: AppliedEntityPlan; price: ShotPrice }
> {
  const project = await loadProject(session.dir);
  const manifest = project.store.manifest();
  const plan = await planEntityDelete(
    {
      ...editInputOf(project),
      characters: project.model.characters,
      locations : project.model.locations,
      inputs    : project.inputs,
      manifest,
    },
    kind,
    id,
    decide,
  );
  if (!plan.ok) return plan;
  const price = priceShotChanges(
    {
      model : await withShots(project),
      config: project.config,
      assets: manifest,
      graph : project.graph,
    },
    plan.changed,
  );
  return { ok: true, project, plan, price };
}

/** Decides what `deleteEntity` would do, cost and leave behind, without doing it. */
export async function previewEntityDelete(
  session: WorkspaceSession,
  kind: 'character' | 'location',
  id: string,
  decide: (world: EntityWorld) => EntityOp,
): Promise<{ ok: boolean; message: string }> {
  const planned = await planEntity(session, kind, id, decide);
  if (!planned.ok) return planned;
  return { ok: true, message: entityPlanMessage(planned.plan, session.dir, planned.price) };
}

/** Deletes a character or a location and rewrites everything that referred to it. */
export async function deleteEntity(
  session: WorkspaceSession,
  kind: 'character' | 'location',
  id: string,
  decide: (world: EntityWorld) => EntityOp,
): Promise<SceneEditResult> {
  const planned = await planEntity(session, kind, id, decide);
  if (!planned.ok) return { ok: false, message: planned.message, written: [], removed: [] };
  const paths = await applyEntityPlan(planned.project, planned.plan);
  const reloaded = await loadProject(session.dir);
  return {
    ok     : true,
    message: entityPlanMessage(planned.plan, session.dir, planned.price, 'Deleted'),
    written: paths.written.map((file) => relPath(session.dir, file)),
    removed: paths.removed.map((file) => relPath(session.dir, file)),
    graph  : storyGraphOf(reloaded.model),
  };
}

/**
 * The decision behind `story.moveShot`, which is the one scene edit whose rule needs the
 * storyboard: `planSceneEdit` hands its callback the script state and nothing else, so the shots
 * are read here and curried in. The result is an ordinary `(state) => LineOp`, so `check` and
 * `run` go through `previewSceneEdit`/`editScene` like every other prose edit.
 */
export async function shotOrder(
  session: WorkspaceSession,
  sceneId: string,
  shot: string,
  after: string,
): Promise<(state: ScriptState) => LineOp> {
  const project = await loadProject(session.dir);
  const scene = project.model.scenes.get(sceneId);
  if (!scene) return () => ({ ok: false, error: `No scene "${sceneId}".` });

  const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
  if (!loaded) {
    return () => ({
      ok   : false,
      error: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
    });
  }
  return moveShot(loaded.shots, { shot, after });
}

/**
 * The line-id patch every affected file would take, computed and not written. Shared by
 * `previewLineIds` and `writeLineIds` so a preview is the decision the write makes, not a
 * description of one — `assignLineIds` is the whole rule, including its safety net.
 */
async function planLineIds(
  session: WorkspaceSession,
  sceneId?: string,
): Promise<{
  ok: boolean;
  message: string;
  assigned: number;
  where: string;
  pending: { source: SceneSource; text: string }[];
}> {
  const project = await loadProject(session.dir);
  const where = sceneId ? `scene "${sceneId}"` : 'the project';
  const fail = (message: string) => ({ ok: false, message, assigned: 0, where, pending: [] });

  if (project.sources.length === 0) return fail('This project has no scene files to edit.');
  const targets = sceneId ? project.sources.filter((s) => s.id === sceneId) : project.sources;
  if (sceneId && targets.length === 0) return fail(`No file holds scene "${sceneId}".`);

  let assigned = 0;
  const pending: { source: SceneSource; text: string }[] = [];
  for (const source of targets) {
    // No scene filter: a chunk holds exactly the one scene, already selected by `targets`.
    const patch = assignLineIds(source.script);
    if (patch.diagnostics.length > 0) {
      return fail(patch.diagnostics.map((d) => d.message).join(' '));
    }
    assigned += patch.assigned;
    if (patch.text !== source.script) pending.push({ source, text: patch.text });
  }
  return { ok: true, message: '', assigned, where, pending };
}

/** What `writeLineIds` would do, without doing it. */
export async function previewLineIds(
  session: WorkspaceSession,
  sceneId?: string,
): Promise<{ ok: boolean; message: string; assigned: number }> {
  const plan = await planLineIds(session, sceneId);
  if (!plan.ok) return { ok: false, message: plan.message, assigned: 0 };
  return {
    ok      : true,
    message: plan.assigned
      ? `${plan.assigned} line id(s) would be written into ${plan.where}.`
      : `Every line in ${plan.where} already carries its id.`,
    assigned: plan.assigned,
  };
}

/**
 * Persist the ids reading already allocated as `[[line:]]` marks. Nothing about the model
 * changes — the ids are the same ones `splitScenes` handed out — so this writes the prose
 * files and reports; what it buys is that a later insertion can no longer shift them.
 */
export async function writeLineIds(
  session: WorkspaceSession,
  sceneId?: string,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const plan = await planLineIds(session, sceneId);
  if (!plan.ok) return { ok: false, message: plan.message, written: [] };
  if (plan.pending.length === 0) {
    return {
      ok     : true,
      message: `Every line in ${plan.where} already carries its id.`,
      written: [],
    };
  }

  for (const { source, text } of plan.pending) {
    await fileCache.write(source.file, source.prefix + text);
  }
  return {
    ok     : true,
    message: `Wrote ${plan.assigned} line id(s) into ${plan.where}.`,
    written: plan.pending.map((p) => relPath(session.dir, p.source.file)),
  };
}
