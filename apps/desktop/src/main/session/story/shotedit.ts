import type { PhaseTimer } from '@vn/commands';
import { readShots, writeShots } from '@vn/store';
import {
  requireShotCast,
  setPanels as planPanels,
  setShotOutfit as planShotOutfit,
  setShotSubjects as planShotSubjects,
  setShotVariant as planShotVariant,
  wardrobesOf,
  type ShotOutfitOp,
} from '@vn/scriptedit';
import type { PagePanel, Scene, Shot } from '@vn/types';
import type { SceneCoverage } from '../../../shared/ipc.js';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject } from '../load/project.js';

type ShotWrite = { ok: boolean; message: string; written: string[]; coverage?: SceneCoverage };

/** The shot-override rule against a fresh load, shared by the preview and the write. */
async function shotOutfitRule(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  character: string,
  outfit: string,
): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
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
  const wardrobes = wardrobesOf(project.model.characters);
  return {
    project,
    op: planShotOutfit(loaded.shots, scene, wardrobes, { shot: shotId, character, outfit }),
  };
}

/** What `story.setOutfit` would do, without writing it. */
export async function previewShotOutfit(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  character: string,
  outfit: string,
): Promise<ShotOutfitOp> {
  return (await shotOutfitRule(session, sceneId, shotId, character, outfit)).op;
}

/**
 * Override what one subject of one shot wears, or clear the override. The third writer of
 * `work/shots/<sceneId>.json`, beside `setCoverage` and `editScene` — and unlike either of them
 * this changes the shot's prompt, so the shot re-hashes and the next run re-renders it.
 */
export async function setShotOutfit(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  character: string,
  outfit: string,
): Promise<ShotWrite> {
  const { project, op } = await shotOutfitRule(session, sceneId, shotId, character, outfit);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, op.shots);
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}

/** The variant rule against a fresh load, shared by the preview and the write. */
async function shotVariantRule(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  variant: string,
): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
  const project = await loadProject(session.dir);
  const scene = project.model.scenes.get(sceneId);
  if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

  const location = project.model.locations.get(scene.location);
  if (!location) {
    return {
      project,
      op: { ok: false, error: `No location "${scene.location}", which ${sceneId} is set in.` },
    };
  }
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
  return {
    project,
    op: planShotVariant(loaded.shots, scene, location, { shot: shotId, variant }),
  };
}

/** What `story.setVariant` would do, without writing it. */
export async function previewShotVariant(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  variant: string,
): Promise<ShotOutfitOp> {
  return (await shotVariantRule(session, sceneId, shotId, variant)).op;
}

/**
 * Set which variant of the scene's location one shot is drawn against. Like `setShotOutfit` this
 * changes the shot's prompt, so the shot re-hashes and the next run re-renders it. Shot fallout
 * does not apply: a variant change touches neither `coversLines` nor `proseHash`.
 */
export async function setShotVariant(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  variant: string,
): Promise<ShotWrite> {
  const { project, op } = await shotVariantRule(session, sceneId, shotId, variant);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, op.shots);
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}

/**
 * A rule over one scene's shots, run against a fresh load. The scene and its decomposition are
 * the two things every such rule needs and the two that can be missing, so the refusals for
 * both are written once here.
 */
async function shotsRule(
  session: WorkspaceSession,
  sceneId: string,
  rule: (shots: readonly Shot[], scene: Scene, project: LoadedProject) => ShotOutfitOp,
  timing?: PhaseTimer,
): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
  const project = timing
    ? await timing.measure('projectLoadMs', () => loadProject(session.dir, timing))
    : await loadProject(session.dir);
  const scene = project.model.scenes.get(sceneId);
  if (!scene) return { project, op: { ok: false, error: `No scene "${sceneId}".` } };

  const read = () => readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
  const loaded = timing ? await timing.measure('shotsReadMs', read) : await read();
  if (!loaded) {
    return {
      project,
      op: {
        ok   : false,
        error: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
      },
    };
  }
  return {
    project,
    op: timing
      ? timing.measureSync('bubbleValidationMs', () => rule(loaded.shots, scene, project))
      : rule(loaded.shots, scene, project),
  };
}

/** What `story.setSubjects` would do, without writing it. */
export async function previewShotSubjects(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  subjects: readonly string[],
): Promise<ShotOutfitOp> {
  return (await subjectsRule(session, sceneId, shotId, subjects)).op;
}

function subjectsRule(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  subjects: readonly string[],
): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
  return shotsRule(session, sceneId, (shots, scene, project) =>
    planShotSubjects(shots, scene, [...project.model.characters.keys()], {
      shot: shotId,
      subjects,
    }),
  );
}

/**
 * Set the characters one shot frames. Like `setShotOutfit` this changes the shot's prompt, so
 * the shot re-hashes and the next run re-renders it — and it changes which character sheets are
 * carried in as references, so the frame is drawn from different material as well.
 */
export async function setShotSubjects(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  subjects: readonly string[],
): Promise<ShotWrite> {
  const { project, op } = await subjectsRule(session, sceneId, shotId, subjects);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, op.shots);
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}

/** What `story.requireCast` would do, without writing it. */
export async function previewShotCast(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  required: boolean,
): Promise<ShotOutfitOp> {
  return (await castRule(session, sceneId, shotId, required)).op;
}

function castRule(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  required: boolean,
): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
  return shotsRule(session, sceneId, (shots, scene) =>
    requireShotCast(shots, scene, { shot: shotId, required }),
  );
}

/**
 * Say whether one shot's cast has to be in the frame it produces. The subjects stay on the shot
 * either way, so the references it is drawn from do not change; only the reviewer's demand does.
 * It is in the prompt, so the frame is drawn again on the next run.
 */
export async function requireCast(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  required: boolean,
): Promise<ShotWrite> {
  const { project, op } = await castRule(session, sceneId, shotId, required);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, op.shots);
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}

/** What `story.setPanels` would do, without writing it. */
export async function previewPanels(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  panels: readonly PagePanel[],
): Promise<ShotOutfitOp> {
  return (await panelsRule(session, sceneId, shotId, panels)).op;
}

function panelsRule(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  panels: readonly PagePanel[],
): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
  return shotsRule(session, sceneId, (shots, scene) =>
    planPanels(shots, { shot: shotId, panels, lineOrder: scene.lines.map((l) => l.id) }),
  );
}

/**
 * Replace one shot's panels: its layout, what each panel frames, and which of its lines each
 * letters. Every part of a panel is in the page's prompt, so the page re-hashes and the next run
 * draws it again. An empty list makes the shot a single frame; a list on a frame makes it a page.
 */
export async function setShotPanels(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  panels: readonly PagePanel[],
): Promise<ShotWrite> {
  const { project, op } = await panelsRule(session, sceneId, shotId, panels);
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, op.shots);
  return {
    ok      : true,
    message : op.message,
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}
