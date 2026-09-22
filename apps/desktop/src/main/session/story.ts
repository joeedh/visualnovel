import { loadConfig, setStartScene } from '@vn/config';
import { rename } from 'node:fs/promises';
import { assignLineIds, headingOf, sceneChunksFromScript, type SceneChunk } from '@vn/model';
import { parseFountain } from '@vn/parse';
import {
  ProjectPaths,
  deleteShots,
  findScreenplay,
  readSceneChunks,
  readShots,
  writeSceneChunk,
  writeShots,
} from '@vn/store';
import { exists, hasConflictMarkers, readText } from '@vn/util';
import { fileCache } from '../workspace/filecache.js';
import { aspectFor, imageParams, layoutDefect, resolveSlot, slotTaskHash } from '@vn/artgen';
import { driftOf } from '@vn/pipeline';
import {
  applyCoverage,
  deleteShot as planDeleteShot,
  letteredPagesNote,
  moveShot,
  requireShotCast,
  newShot as planNewShot,
  setBubbles,
  setCoverage,
  setPanels,
  setSceneOutfit,
  setSheet,
  setSheetGroup,
  setShotOutfit,
  setShotSubjects,
  setShotVariant,
  wardrobesOf,
  type BranchOp,
  type DeleteShotOp,
  type LineOp,
  type NewShotOp,
  type SceneOutfitOp,
  type ScriptState,
  type SheetsOp,
  type ShotOutfitOp,
} from '@vn/scriptedit';
import {
  applyMarkerPlan,
  applyScenePlan,
  planMarkerEdit,
  planSceneEdit,
  scenePlanMessage,
  scriptStateOf,
  type ScenePlan,
  type SceneSource,
} from '@vn/scriptedit/write';
import type { DefectReport, PagePanel, PanelBubble, Scene, Shot } from '@vn/types';
import type {
  BranchEditResult,
  SceneCoverage,
  SceneEditResult,
  ShotFailure,
  StoryGraph,
} from '../../shared/ipc.js';
import { storyGraphOf } from '../doctree/storygraph.js';
import type { WorkspaceSession, LoadedProject } from './core.js';
import { editInputOf, relPath, loadProject } from './core.js';

/**
 * The layout verdict the Page editor's header shows: the runner's own `layout` defect over the
 * boxes the reviewer measured, or nothing for a frame, an unmeasured page, or a page that matched.
 */
function layoutVerdict(shot: Shot): { layout?: string } {
  if (!shot.panels || !shot.panelBoxes) return {};
  const defect = layoutDefect(shot.panels, shot.panelBoxes);
  return defect ? { layout: defect.description } : {};
}

export class StoryPart {
  constructor(private readonly session: WorkspaceSession) {}

  async storyGraph(): Promise<StoryGraph> {
    const project = await loadProject(this.session.dir);
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
  async editBranches(decide: (scenes: Map<string, Scene>) => BranchOp): Promise<BranchEditResult> {
    const project = await loadProject(this.session.dir);
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
    const reloaded = await loadProject(this.session.dir);
    return {
      ok     : true,
      message: op.message,
      written: files.map((file) => relPath(this.session.dir, file)),
      graph  : storyGraphOf(reloaded.model),
    };
  }

  /**
   * The scenes a prose edit is decided against: as their chunks parse, with cues still the ones
   * the author typed — deliberately not the model's, which resolves each cue to a character id.
   * This is what an interaction's `targets` enumerates over; a command's own `check` goes through
   * `previewSceneEdit`, which decides against this same state and prices the storyboard too.
   */
  async scriptState(): Promise<ScriptState> {
    const project = await loadProject(this.session.dir);
    return scriptStateOf(project.sources, project.config.start);
  }

  /**
   * A prose edit decided against a fresh load and not written — `@vn/scriptedit` owns the rules and
   * the proof; this is only the load. Shared by `previewSceneEdit` and `editScene`, so a `check`
   * reports the consequence the run produces rather than a description of one.
   */
  private async planScene(
    decide: (state: ScriptState) => LineOp,
  ): Promise<{ project: LoadedProject; plan: ScenePlan }> {
    const project = await loadProject(this.session.dir);
    return { project, plan: await planSceneEdit(editInputOf(project), decide) };
  }

  /** What `editScene` would do and cost the storyboard, without doing it. */
  async previewSceneEdit(
    decide: (state: ScriptState) => LineOp,
  ): Promise<{ ok: boolean; message: string }> {
    const { plan } = await this.planScene(decide);
    if (!plan.ok) return { ok: false, message: plan.message };
    return { ok: true, message: scenePlanMessage(plan) };
  }

  /**
   * The single write path for every prose edit, and the sibling of `editBranches`: apply the proved
   * plan — chunks, storyboards, removals — then rebuild the model. The app's own part is reporting:
   * `applyScenePlan` answers in absolute paths, and a `written` list is workspace-relative.
   */
  async editScene(decide: (state: ScriptState) => LineOp): Promise<SceneEditResult> {
    const { project, plan } = await this.planScene(decide);
    if (!plan.ok) return { ok: false, message: plan.message, written: [], removed: [] };

    const input = editInputOf(project);
    const paths = await applyScenePlan(input, plan);
    const written = paths.written.map((file) => relPath(this.session.dir, file));
    const removed = paths.removed.map((file) => relPath(this.session.dir, file));

    if (written.length === 0 && removed.length === 0) {
      return {
        ok     : true,
        message: `${plan.message} (already reads that way — nothing written)`,
        written: [],
        removed: [],
        graph  : storyGraphOf(project.model),
      };
    }
    const reloaded = await loadProject(this.session.dir);
    return {
      ok     : true,
      message: scenePlanMessage(plan),
      written,
      removed,
      graph: storyGraphOf(reloaded.model),
    };
  }

  /**
   * The decision behind `story.moveShot`, which is the one scene edit whose rule needs the
   * storyboard: `planSceneEdit` hands its callback the script state and nothing else, so the shots
   * are read here and curried in. The result is an ordinary `(state) => LineOp`, so `check` and
   * `run` go through `previewSceneEdit`/`editScene` like every other prose edit.
   */
  async shotOrder(
    sceneId: string,
    shot: string,
    after: string,
  ): Promise<(state: ScriptState) => LineOp> {
    const project = await loadProject(this.session.dir);
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
  private async planLineIds(sceneId?: string): Promise<{
    ok: boolean;
    message: string;
    assigned: number;
    where: string;
    pending: { source: SceneSource; text: string }[];
  }> {
    const project = await loadProject(this.session.dir);
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
  async previewLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; assigned: number }> {
    const plan = await this.planLineIds(sceneId);
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
  async writeLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const plan = await this.planLineIds(sceneId);
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
      written: plan.pending.map((p) => relPath(this.session.dir, p.source.file)),
    };
  }

  /**
   * The migration `workspace.import` would perform, decided and not written: the chunks
   * `sceneChunksFromScript` proved read back as the same scenes, plus the screenplay to move
   * aside. Shared with `previewImport`, so a refused check reports the same message the run
   * would.
   */
  private async planImport(): Promise<{
    ok: boolean;
    message: string;
    chunks: SceneChunk[];
    entry: string | undefined;
    scriptPath: string | undefined;
  }> {
    const paths = new ProjectPaths(this.session.dir);
    const fail = (message: string) => ({
      ok: false,
      message,
      chunks    : [],
      entry     : undefined,
      scriptPath: undefined,
    });

    // An existing chunk is either a previous import or hand-authored work, and importing over
    // the second is the loss this refusal exists to prevent.
    const already = await readSceneChunks(paths);
    if (already.length > 0) {
      return fail(`scenes/ already holds ${already.length} chunk(s); importing would overwrite.`);
    }
    // Uses the same finder the loader uses to report a leftover screenplay, so the file this
    // converts is the file that warning names — not a second opinion about which one it is.
    const scriptPath = await findScreenplay(paths);
    if (scriptPath === undefined) {
      return fail('There is no screenplay/*.fountain to import.');
    }
    const aside = `${scriptPath}.imported`;
    if (await exists(aside)) return fail(`${relPath(this.session.dir, aside)} already exists.`);

    const config = await loadConfig(this.session.dir);
    const result = sceneChunksFromScript(
      parseFountain(await readText(scriptPath)),
      config.start === undefined ? {} : { start: config.start },
    );
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) return fail(errors.map((d) => d.message).join(' '));

    const warnings = result.diagnostics.length ? ` ${result.diagnostics.length} warning(s).` : '';
    return {
      ok     : true,
      message: `${result.chunks.length} scene(s) would move into scenes/.${warnings}`,
      chunks : result.chunks,
      entry  : result.entry,
      scriptPath,
    };
  }

  /** What `importScreenplay` would do, without doing it. */
  async previewImport(): Promise<{ ok: boolean; message: string }> {
    const { ok, message } = await this.planImport();
    return { ok, message };
  }

  /**
   * Convert a `screenplay/*.fountain` project into one chunk per scene — the `vngen import`
   * equivalent. The screenplay is moved aside rather than deleted, and moved last: while it is
   * still a `.fountain` the project reports it on every load, so the rename finishes the import.
   */
  async importScreenplay(): Promise<{ ok: boolean; message: string; written: string[] }> {
    const plan = await this.planImport();
    if (!plan.ok || plan.scriptPath === undefined) {
      return { ok: false, message: plan.message, written: [] };
    }

    const paths = new ProjectPaths(this.session.dir);
    const written: string[] = [];
    for (const chunk of plan.chunks) {
      await writeSceneChunk(paths, chunk.id, chunk.doc);
      written.push(relPath(this.session.dir, paths.sceneFile(chunk.id)));
    }
    // A directory has no document order, so the entry the screenplay implied is written down.
    if (plan.entry !== undefined && (await setStartScene(this.session.dir, plan.entry))) {
      written.push(relPath(this.session.dir, paths.projectConfig));
    }
    const aside = `${plan.scriptPath}.imported`;
    await rename(plan.scriptPath, aside);
    written.push(relPath(this.session.dir, aside));

    return {
      ok     : true,
      message:
        `Imported ${plan.chunks.length} scene(s) into scenes/; the screenplay is now ` +
        `${relPath(this.session.dir, aside)} — delete it once you are satisfied.`,
      written,
    };
  }

  /**
   * One scene's script and shots for the coverage timeline. Shots come off disk: a model built
   * from inputs carries none, and the persisted decomposition is the one the run illustrated.
   */
  async sceneCoverage(sceneId: string): Promise<SceneCoverage> {
    const project = await loadProject(this.session.dir);
    const scene = project.model.scenes.get(sceneId);
    if (!scene) throw new Error(`No scene "${sceneId}".`);

    const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    const exts = new Map(project.store.manifest().map((a) => [a.hash, a.ext]));
    const shotsById = new Map<string, Shot[] | null>([[sceneId, loaded?.shots ?? []]]);
    // The slot's current task, for the frame a blocked render left and the sentence saying why
    const outcomeOf = (s: Shot): { image?: string; failure?: ShotFailure; undrawable?: string } => {
      const decided = resolveSlot(
        { kind: 'shot', sceneId, shotId: s.id },
        { model: project.model, shots: shotsById, config: project.config, graph: project.graph },
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
  async setCoverage(
    sceneId: string,
    shotId: string,
    lines: readonly string[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const project = await loadProject(this.session.dir);
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
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /**
   * The scene-marker outfit rule against a fresh load: the wardrobes it is checked against and the
   * scenes it would be decided over, from the same read. `decide` is handed to `editBranches`
   * rather than run here, so the patch sees the scenes the rule saw.
   */
  private async sceneOutfitRule(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<{
    project: LoadedProject;
    decide: (scenes: Map<string, Scene>) => SceneOutfitOp;
  }> {
    const project = await loadProject(this.session.dir);
    const wardrobes = wardrobesOf(project.model.characters);
    return {
      project,
      decide: (scenes) => setSceneOutfit(scenes, wardrobes, { scene: sceneId, character, outfit }),
    };
  }

  /** The decision behind `story.setSceneOutfit`, curried for `editBranches` like `shotOrder`. */
  async sceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<(scenes: Map<string, Scene>) => SceneOutfitOp> {
    return (await this.sceneOutfitRule(sceneId, character, outfit)).decide;
  }

  /**
   * What `story.setSceneOutfit` would do, decided without writing. It does not preview against
   * the story graph the other branch checks use: that projection carries edges and reachability,
   * and the outfit markers this rule needs are not in it.
   */
  async previewSceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<SceneOutfitOp> {
    const { project, decide } = await this.sceneOutfitRule(sceneId, character, outfit);
    return decide(project.model.scenes);
  }

  /** The shot-override rule against a fresh load, shared by the preview and the write. */
  private async shotOutfitRule(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    const project = await loadProject(this.session.dir);
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
      op: setShotOutfit(loaded.shots, scene, wardrobes, { shot: shotId, character, outfit }),
    };
  }

  /** What `story.setOutfit` would do, without writing it. */
  async previewShotOutfit(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<ShotOutfitOp> {
    return (await this.shotOutfitRule(sceneId, shotId, character, outfit)).op;
  }

  /**
   * Override what one subject of one shot wears, or clear the override. The third writer of
   * `work/shots/<sceneId>.json`, beside `setCoverage` and `editScene` — and unlike either of them
   * this changes the shot's prompt, so the shot re-hashes and the next run re-renders it.
   */
  async setShotOutfit(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.shotOutfitRule(sceneId, shotId, character, outfit);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /** The variant rule against a fresh load, shared by the preview and the write. */
  private async shotVariantRule(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    const project = await loadProject(this.session.dir);
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
      op: setShotVariant(loaded.shots, scene, location, { shot: shotId, variant }),
    };
  }

  /** What `story.setVariant` would do, without writing it. */
  async previewShotVariant(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<ShotOutfitOp> {
    return (await this.shotVariantRule(sceneId, shotId, variant)).op;
  }

  /**
   * Set which variant of the scene's location one shot is drawn against. Like `setShotOutfit` this
   * changes the shot's prompt, so the shot re-hashes and the next run re-renders it. Shot fallout
   * does not apply: a variant change touches neither `coversLines` nor `proseHash`.
   */
  async setShotVariant(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.shotVariantRule(sceneId, shotId, variant);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /**
   * A rule over one scene's shots, run against a fresh load. The scene and its decomposition are
   * the two things every such rule needs and the two that can be missing, so the refusals for
   * both are written once here.
   */
  private async shotsRule(
    sceneId: string,
    rule: (shots: readonly Shot[], scene: Scene, project: LoadedProject) => ShotOutfitOp,
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    const project = await loadProject(this.session.dir);
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
    return { project, op: rule(loaded.shots, scene, project) };
  }

  /** What `story.setSubjects` would do, without writing it. */
  async previewShotSubjects(
    sceneId: string,
    shotId: string,
    subjects: readonly string[],
  ): Promise<ShotOutfitOp> {
    return (await this.subjectsRule(sceneId, shotId, subjects)).op;
  }

  private subjectsRule(
    sceneId: string,
    shotId: string,
    subjects: readonly string[],
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    return this.shotsRule(sceneId, (shots, scene, project) =>
      setShotSubjects(shots, scene, [...project.model.characters.keys()], {
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
  async setShotSubjects(
    sceneId: string,
    shotId: string,
    subjects: readonly string[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.subjectsRule(sceneId, shotId, subjects);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /** What `story.requireCast` would do, without writing it. */
  async previewShotCast(sceneId: string, shotId: string, required: boolean): Promise<ShotOutfitOp> {
    return (await this.castRule(sceneId, shotId, required)).op;
  }

  private castRule(
    sceneId: string,
    shotId: string,
    required: boolean,
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    return this.shotsRule(sceneId, (shots, scene) =>
      requireShotCast(shots, scene, { shot: shotId, required }),
    );
  }

  /**
   * Say whether one shot's cast has to be in the frame it produces. The subjects stay on the shot
   * either way, so the references it is drawn from do not change; only the reviewer's demand does.
   * It is in the prompt, so the frame is drawn again on the next run.
   */
  async requireShotCast(
    sceneId: string,
    shotId: string,
    required: boolean,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.castRule(sceneId, shotId, required);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /** What `story.setPanels` would do, without writing it. */
  async previewPanels(
    sceneId: string,
    shotId: string,
    panels: readonly PagePanel[],
  ): Promise<ShotOutfitOp> {
    return (await this.panelsRule(sceneId, shotId, panels)).op;
  }

  private panelsRule(
    sceneId: string,
    shotId: string,
    panels: readonly PagePanel[],
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    return this.shotsRule(sceneId, (shots, scene) =>
      setPanels(shots, { shot: shotId, panels, lineOrder: scene.lines.map((l) => l.id) }),
    );
  }

  /**
   * Replace one shot's panels: its layout, what each panel frames, and which of its lines each
   * letters. Every part of a panel is in the page's prompt, so the page re-hashes and the next run
   * draws it again. An empty list makes the shot a single frame; a list on a frame makes it a page.
   */
  async setPanels(
    sceneId: string,
    shotId: string,
    panels: readonly PagePanel[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.panelsRule(sceneId, shotId, panels);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /** What `story.setBubbles` would do, without writing it. */
  async previewBubbles(
    sceneId: string,
    shotId: string,
    bubbles: readonly PanelBubble[],
  ): Promise<ShotOutfitOp> {
    return (await this.bubblesRule(sceneId, shotId, bubbles)).op;
  }

  private bubblesRule(
    sceneId: string,
    shotId: string,
    bubbles: readonly PanelBubble[],
  ): Promise<{ project: LoadedProject; op: ShotOutfitOp }> {
    return this.shotsRule(sceneId, (shots) => setBubbles(shots, { shot: shotId, bubbles }));
  }

  /**
   * Restate where the runner draws one page's bubbles. No prompt reads a bubble, so nothing
   * re-hashes and nothing is drawn again; the page's lines without one keep the dialogue box.
   */
  async setBubbles(
    sceneId: string,
    shotId: string,
    bubbles: readonly PanelBubble[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.bubblesRule(sceneId, shotId, bubbles);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots);
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /**
   * The sheet-group rules against a fresh load, shared by the previews and the writes. The
   * shots file's own `sheets` is read here, since the model's scenes do not carry it.
   */
  private async sheetsRule(
    sceneId: string,
    rule: (shots: readonly Shot[], sheets: Scene['sheets']) => SheetsOp<Shot>,
  ): Promise<{ project: LoadedProject; op: SheetsOp<Shot> }> {
    const project = await loadProject(this.session.dir);
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
  async previewSheet(sceneId: string, shotId: string, sheet: string): Promise<SheetsOp<Shot>> {
    return (
      await this.sheetsRule(sceneId, (shots, sheets) =>
        setSheet(shots, sheets, { shot: shotId, sheet }),
      )
    ).op;
  }

  /**
   * Puts one shot in a staging-sheet group, or takes it out. The group's members are in the
   * sheet's key, so every member is drawn again on the next run.
   */
  async setSheet(
    sceneId: string,
    shotId: string,
    sheet: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.sheetsRule(sceneId, (shots, sheets) =>
      setSheet(shots, sheets, { shot: shotId, sheet }),
    );
    return this.writeSheets(project, sceneId, op);
  }

  /** What `story.setSheetGroup` would do, without writing it. */
  async previewSheetGroup(
    sceneId: string,
    args: { sheet: string; seed?: number; notes?: string },
  ): Promise<SheetsOp<Shot>> {
    return (await this.sheetsRule(sceneId, (shots, sheets) => setSheetGroup(shots, sheets, args)))
      .op;
  }

  /** Sets a group's seed and notes, which re-keys every member; a new seed is how a sheet is rerolled. */
  async setSheetGroup(
    sceneId: string,
    args: { sheet: string; seed?: number; notes?: string },
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.sheetsRule(sceneId, (shots, sheets) =>
      setSheetGroup(shots, sheets, args),
    );
    return this.writeSheets(project, sceneId, op);
  }

  private async writeSheets(
    project: LoadedProject,
    sceneId: string,
    op: SheetsOp<Shot>,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots, { sheets: op.sheets });
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /**
   * The new-shot rule against a fresh load, shared by the preview and the write. The scene's
   * location supplies the variant ids the default is validated against, the same way the model
   * decomposer's answer is.
   */
  private async newShotRule(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[],
  ): Promise<{ project: LoadedProject; op: NewShotOp }> {
    const project = await loadProject(this.session.dir);
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
  async previewNewShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ): Promise<NewShotOp> {
    return (await this.newShotRule(sceneId, lines, framing, subjects)).op;
  }

  /**
   * Create a shot by hand — on an undecomposed scene, this writes the storyboard file itself,
   * which ends decomposition for the scene. This is the only writer that advances the `nextShot`
   * mark: the id it spends is retired by the same write.
   */
  async newShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.newShotRule(sceneId, lines, framing, subjects);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    await writeShots(project.paths, sceneId, op.shots, { nextShot: op.nextShot });
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /** The delete-shot rule against a fresh load, shared by the preview and the write. */
  private async deleteShotRule(
    sceneId: string,
    shotId: string,
  ): Promise<{ project: LoadedProject; op: DeleteShotOp }> {
    const project = await loadProject(this.session.dir);
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
  async previewDeleteShot(sceneId: string, shotId: string): Promise<DeleteShotOp> {
    return (await this.deleteShotRule(sceneId, shotId)).op;
  }

  /**
   * Delete a shot. Removing the last one deletes the file itself — restoring the one signal that
   * means "decompose this scene" — and otherwise the rewrite carries the `nextShot` mark, so the
   * freed id stays retired.
   */
  async deleteShot(
    sceneId: string,
    shotId: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    const { project, op } = await this.deleteShotRule(sceneId, shotId);
    if (!op.ok) return { ok: false, message: op.error, written: [] };

    if (op.deleteFile) await deleteShots(project.paths, sceneId);
    else await writeShots(project.paths, sceneId, op.shots, { nextShot: op.nextShot });
    return {
      ok      : true,
      message : op.message,
      written : [`vngen/work/shots/${sceneId}.json`],
      coverage: await this.session.sceneCoverage(sceneId),
    };
  }

  /** Build the playable live from the current model + asset store (no file needed). */
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
