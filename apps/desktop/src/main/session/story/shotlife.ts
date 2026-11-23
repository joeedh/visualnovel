import { deleteShots, readShots, writeShots } from '@vn/store';
import {
  deleteShot as planDeleteShot,
  newShot as planNewShot,
  setSheet as planSheet,
  setSheetGroup as planSheetGroup,
  type DeleteShotOp,
  type NewShotOp,
  type SheetsOp,
} from '@vn/scriptedit';
import type { ProductionData, Shot } from '@vn/types';
import type { SceneCoverage } from '../../../shared/ipc.js';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject } from '../load/project.js';

type ShotWrite = { ok: boolean; message: string; written: string[]; coverage?: SceneCoverage };

/**
 * The sheet-group rules against a fresh load, shared by the previews and the writes. The
 * shots file's own `sheets` is read here, since a loaded project's production map is empty.
 */
async function sheetsRule(
  session: WorkspaceSession,
  sceneId: string,
  rule: (shots: readonly Shot[], sheets: ProductionData['sheets']) => SheetsOp<Shot>,
): Promise<{ project: LoadedProject; op: SheetsOp<Shot> }> {
  const project = await loadProject(session.dir);
  const scene = project.model.scenes.get(sceneId);
  if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

  const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
  if (!loaded) {
    return {
      project,
      op: {
        ok   : false,
        error: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
      },
    };
  }
  return { project, op: rule(loaded.shots, loaded.sheets) };
}

/** What `story.setSheet` would do, without writing it. */
export async function previewSheet(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  sheet: string,
): Promise<SheetsOp<Shot>> {
  return (
    await sheetsRule(session, sceneId, (shots, sheets) =>
      planSheet(shots, sheets, { shot: shotId, sheet }),
    )
  ).op;
}

/**
 * Puts one shot in a staging-sheet group, or takes it out. The group's members are in the
 * sheet's key, so every member is drawn again on the next run.
 */
export async function setSheet(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  sheet: string,
): Promise<ShotWrite> {
  const { project, op } = await sheetsRule(session, sceneId, (shots, sheets) =>
    planSheet(shots, sheets, { shot: shotId, sheet }),
  );
  return writeSheets(session, project, sceneId, op);
}

/** What `story.setSheetGroup` would do, without writing it. */
export async function previewSheetGroup(
  session: WorkspaceSession,
  sceneId: string,
  args: { sheet: string; seed?: number; notes?: string },
): Promise<SheetsOp<Shot>> {
  return (
    await sheetsRule(session, sceneId, (shots, sheets) => planSheetGroup(shots, sheets, args))
  ).op;
}

/** Sets a group's seed and notes, which re-keys every member; a new seed is how a sheet is rerolled. */
export async function setSheetGroup(
  session: WorkspaceSession,
  sceneId: string,
  args: { sheet: string; seed?: number; notes?: string },
): Promise<ShotWrite> {
  const { project, op } = await sheetsRule(session, sceneId, (shots, sheets) =>
    planSheetGroup(shots, sheets, args),
  );
  return writeSheets(session, project, sceneId, op);
}

async function writeSheets(
  session: WorkspaceSession,
  project: LoadedProject,
  sceneId: string,
  op: SheetsOp<Shot>,
): Promise<ShotWrite> {
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, op.shots, { sheets: op.sheets });
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}

/**
 * The new-shot rule against a fresh load, shared by the preview and the write. The scene's
 * location supplies the variant ids the default is validated against, the same way the model
 * decomposer's answer is.
 */
async function newShotRule(
  session: WorkspaceSession,
  sceneId: string,
  lines: readonly string[],
  framing: string,
  subjects: readonly string[],
): Promise<{ project: LoadedProject; op: NewShotOp }> {
  const project = await loadProject(session.dir);
  const scene = project.model.scenes.get(sceneId);
  if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

  const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
  const location = project.model.locations.get(scene.location);
  const op = planNewShot(scene, loaded, {
    lines,
    ...(framing ? { framing: framing as Shot['framing'] } : {}),
    subjects,
    variants: location?.variants.map((v) => v.id) ?? [],
    cast    : [...project.model.characters.keys()],
  });
  return { project, op };
}

/** What `story.newShot` would do, without writing it. */
export async function previewNewShot(
  session: WorkspaceSession,
  sceneId: string,
  lines: readonly string[],
  framing: string,
  subjects: readonly string[] = [],
): Promise<NewShotOp> {
  return (await newShotRule(session, sceneId, lines, framing, subjects)).op;
}

/**
 * Create a shot by hand — on an undecomposed scene, this writes the storyboard file itself,
 * which ends decomposition for the scene. This is the only writer that advances the `nextShot`
 * mark: the id it spends is retired by the same write.
 */
export async function newShot(
  session: WorkspaceSession,
  sceneId: string,
  lines: readonly string[],
  framing: string,
  subjects: readonly string[] = [],
): Promise<ShotWrite> {
  const { project, op } = await newShotRule(session, sceneId, lines, framing, subjects);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, op.shots, { nextShot: op.nextShot });
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}

/** The delete-shot rule against a fresh load, shared by the preview and the write. */
async function deleteShotRule(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
): Promise<{ project: LoadedProject; op: DeleteShotOp }> {
  const project = await loadProject(session.dir);
  const scene = project.model.scenes.get(sceneId);
  if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

  const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
  if (!loaded) {
    return {
      project,
      op: { ok: false, error: `Scene "${sceneId}" has no decomposition yet.` },
    };
  }
  return { project, op: planDeleteShot(loaded, { shot: shotId }) };
}

/** What `story.deleteShot` would do, without writing it. */
export async function previewDeleteShot(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
): Promise<DeleteShotOp> {
  return (await deleteShotRule(session, sceneId, shotId)).op;
}

/**
 * Delete a shot. Removing the last one deletes the file itself — restoring the one signal that
 * means "decompose this scene" — and otherwise the rewrite carries the `nextShot` mark, so the
 * freed id stays retired.
 */
export async function deleteShot(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
): Promise<ShotWrite> {
  const { project, op } = await deleteShotRule(session, sceneId, shotId);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  if (op.deleteFile) await deleteShots(project.paths, sceneId);
  else await writeShots(project.paths, sceneId, op.shots, { nextShot: op.nextShot });
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}
