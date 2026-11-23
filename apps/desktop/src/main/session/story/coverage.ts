import { headingOf } from '@vn/model';
import { productionOf, readShots, writeShots } from '@vn/store';
import { hasConflictMarkers, readText } from '@vn/util';
import {
  aspectFor,
  driftOf,
  imageParams,
  layoutDefect,
  resolveSlot,
  slotTaskHash,
} from '@vn/stills';
import { applyCoverage, letteredPagesNote, setCoverage, wardrobesOf } from '@vn/scriptedit';
import type { DefectReport, Shot } from '@vn/types';
import type { SceneCoverage, ShotFailure } from '../../../shared/ipc.js';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject } from '../load/project.js';

/**
 * The layout verdict the Page editor's header shows: the runner's own `layout` defect over the
 * boxes the reviewer measured, or nothing for a frame, an unmeasured page, or a page that matched.
 */
function layoutVerdict(shot: Shot): { layout?: string } {
  if (!shot.panels || !shot.panelBoxes) return {};
  const defect = layoutDefect(shot.panels, shot.panelBoxes);
  return defect ? { layout: defect.description } : {};
}

/**
 * One scene's script and shots for the coverage timeline. Shots come off disk: a model built
 * from inputs carries none, and the persisted decomposition is the one the run illustrated.
 */
export async function sceneCoverage(
  session: WorkspaceSession,
  sceneId: string,
): Promise<SceneCoverage> {
  const project = await loadProject(session.dir);
  return coverageFromProject(sceneId, project);
}

/** Reuse this edit's project snapshot; shots are read after persistence to retain file metadata. */
async function coverageFromProject(
  sceneId: string,
  project: LoadedProject,
): Promise<SceneCoverage> {
  const scene = project.model.scenes.get(sceneId);
  if (!scene) throw new Error(`No scene "${sceneId}".`);

  const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
  const model = {
    ...project.model,
    production: new Map(loaded ? [[sceneId, productionOf(loaded)]] : []),
  };
  const manifest = project.store.manifest();
  const exts = new Map(manifest.map((a) => [a.hash, a.ext]));
  // The slot's current task, for the frame a blocked render left and the sentence saying why
  const outcomeOf = (s: Shot): { image?: string; failure?: ShotFailure; undrawable?: string } => {
    const decided = resolveSlot(
      { kind: 'shot', sceneId, shotId: s.id },
      {
        model,
        config: project.config,
        assets: manifest,
        graph : project.graph,
      },
    );
    if (!decided.ok) return { undrawable: decided.reason };
    const task = project.graph.get(slotTaskHash(decided.plan));
    if (!task || (task.status !== 'failed' && task.status !== 'needs_human')) return {};
    const last = task.attempts[task.attempts.length - 1];
    return {
      ...(last?.output === undefined ? {} : { image: last.output }),
      failure: {
        task  : task.hash,
        status: task.status,
        ...(task.error === undefined ? {} : { error: task.error }),
        defects: blockingDefects(last?.reviews),
      },
    };
  };
  const wardrobes = wardrobesOf(project.model.characters);
  const params = imageParams(project.config);
  const conflicted = hasConflictMarkers(await readText(project.paths.sceneFile(sceneId)));
  const pageAspect = project.config.image_params.page_aspect;
  // Whoever the scene declares, plus anyone a shot actually frames — a subject the scene's
  // `characters` list forgot is still someone the strip has to be able to dress.
  const cast = new Set([
    ...scene.characters,
    ...(loaded?.shots ?? []).flatMap((s) => s.subjects.map((sub) => sub.characterId)),
  ]);
  return {
    sceneId,
    location   : scene.location,
    heading    : headingOf(scene),
    lines: scene.lines.map((l) => ({
      id  : l.id,
      kind: l.kind,
      ...(l.speaker ? { speaker: l.speaker } : {}),
      text: l.text,
    })),
    shots: (loaded?.shots ?? []).map((s) => {
      const outcome = outcomeOf(s);
      const image = s.image ?? outcome.image;
      return {
        id      : s.id,
        framing : s.framing,
        subjects: s.subjects.map((sub) => sub.characterId),
        location: s.location,
        ...(s.castOptional ? { castOptional: true } : {}),
        // Only the subjects that state one: the strip resolves the rest through `outfitFor`,
        // and a map that pre-filled the inherited answer would erase the distinction.
        outfits: Object.fromEntries(
          s.subjects.filter((sub) => sub.outfit).map((sub) => [sub.characterId, sub.outfit!]),
        ),
        coversLines: s.coversLines,
        ...(s.panels ? { panels: s.panels } : {}),
        ...(s.panelBoxes ? { panelBoxes: s.panelBoxes } : {}),
        ...layoutVerdict(s),
        aspect: aspectFor(params, s, pageAspect).aspect ?? project.config.image_params.aspect,
        ...(image ? { image: { hash: image, ext: exts.get(image) ?? 'png' } } : {}),
        ...(outcome.failure ? { failure: outcome.failure } : {}),
        ...(outcome.undrawable ? { undrawable: outcome.undrawable } : {}),
        ...(s.imageModel ? { imageModel: s.imageModel } : {}),
        // Against `scene` as just loaded, so an edit made anywhere — this app, the CLI, the
        // agent, a hand-edit — shows up the next time the strip is read.
        drift: driftOf(scene, s),
      };
    }),
    // A character with no sheet has no wardrobe to offer, so it gets no row rather than a
    // control whose every option the command would refuse.
    cast: [...cast].flatMap((id) => {
      const wardrobe = wardrobes.get(id);
      if (!wardrobe) return [];
      const marked = scene.outfits?.[id];
      return [{ id, ...wardrobe, ...(marked ? { marked } : {}) }];
    }),
    // Only the ones with a wardrobe, for the reason `cast` is filtered: a shot may only be
    // given a character the subject rule would accept.
    characters : [...wardrobes.keys()],
    variants   : (project.model.locations.get(scene.location)?.variants ?? []).map((v) => v.id),
    decomposed : loaded !== null,
    lettering  : project.config.lettering,
    bubbleNames: project.config.bubble_names,
    names: Object.fromEntries([...project.model.characters.values()].map((c) => [c.id, c.name])),
    imageModel : project.config.models.image,
    ...(loaded?.nextShot !== undefined ? { nextShot: loaded.nextShot } : {}),
    ...(conflicted ? { conflicted: true } : {}),
  };
}

/**
 * Rewrite one shot's coverage. The rule is `@vn/scriptedit`'s `setCoverage`, so the timeline's mid-drag
 * preview and this write cannot disagree. On a frame only `coversLines` is touched, which
 * `buildShotPrompt` ignores, so no task rehashes and no generated art is invalidated. On a page
 * the panels' lines move with it, and under `lettering: model` those lines are in the prompt,
 * so the page re-keys; `story.setCoverage`'s check prices that.
 */
export async function setShotCoverage(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  lines: readonly string[],
): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
  const project = await loadProject(session.dir);
  const scene = project.model.scenes.get(sceneId);
  if (!scene) return { ok: false, message: `No scene "${sceneId}".`, written: [] };

  const lineOrder = scene.lines.map((l) => l.id);
  const loaded = await readShots(project.paths, sceneId, new Set(lineOrder));
  if (!loaded) {
    return {
      ok     : false,
      message: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
      written: [],
    };
  }

  const op = setCoverage(loaded.shots, { shot: shotId, lines, lineOrder });
  if (!op.ok) return { ok: false, message: op.error, written: [] };

  await writeShots(project.paths, sceneId, applyCoverage(loaded.shots, op.changed));

  const gaps = op.uncovered.length ? ` ${op.uncovered.length} line(s) now uncovered.` : '';
  return {
    ok      : true,
    message : op.message + gaps + letteredPagesNote(op.changed, project.config.lettering),
    written : [`vngen/work/shots/${sceneId}.json`],
    coverage: await session.sceneCoverage(sceneId),
  };
}

/** The blocking defects a review round named, deduplicated, in the reviewers' own words. */
function blockingDefects(reviews: unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const report of (reviews ?? []) as Partial<DefectReport>[]) {
    for (const defect of report.defects ?? []) {
      if (defect.severity === 'blocking') out.add(`${defect.category}: ${defect.description}`);
    }
  }
  return [...out];
}
