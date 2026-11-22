import type { PhaseTimer } from '@vn/commands';
import type {
  BranchOp,
  DeleteShotOp,
  EntityOp,
  EntityWorld,
  LineOp,
  NewShotOp,
  SceneOutfitOp,
  ScriptState,
  SheetsOp,
  ShotOutfitOp,
} from '@vn/scriptedit';
import type { PagePanel, PanelBubble, Scene, Shot } from '@vn/types';
import type {
  BranchEditResult,
  SceneCoverage,
  SceneEditResult,
  StoryGraph,
} from '../../../shared/ipc.js';
import type { StoryPart } from '../story.js';
import { DocsSurface } from './docs.js';
export abstract class StorySurface extends DocsSurface {
  abstract readonly storyPart: StoryPart;

  async storyGraph(): Promise<StoryGraph> {
    return this.storyPart.storyGraph();
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
    return this.storyPart.editBranches(decide);
  }

  /**
   * The scenes a prose edit is decided against: as their chunks parse, with cues still the ones
   * the author typed — deliberately not the model's, which resolves each cue to a character id.
   * This is what an interaction's `targets` enumerates over; a command's own `check` goes through
   * `previewSceneEdit`, which decides against this same state and prices the storyboard too.
   */
  async scriptState(): Promise<ScriptState> {
    return this.storyPart.scriptState();
  }

  async previewSceneEdit(
    decide: (state: ScriptState) => LineOp,
  ): Promise<{ ok: boolean; message: string }> {
    return this.storyPart.previewSceneEdit(decide);
  }

  /** Lists the files a prose edit would remove, workspace-relative. */
  sceneEditRemovals(decide: (state: ScriptState) => LineOp): Promise<string[]> {
    return this.storyPart.sceneEditRemovals(decide);
  }

  /**
   * The single write path for every prose edit, and the sibling of `editBranches`: apply the proved
   * plan — chunks, storyboards, removals — then rebuild the model. The app's own part is reporting:
   * `applyScenePlan` answers in absolute paths, and a `written` list is workspace-relative.
   */
  async editScene(decide: (state: ScriptState) => LineOp): Promise<SceneEditResult> {
    return this.storyPart.editScene(decide);
  }

  previewEntityDelete(
    kind: 'character' | 'location',
    id: string,
    decide: (world: EntityWorld) => EntityOp,
  ): Promise<{ ok: boolean; message: string }> {
    return this.storyPart.previewEntityDelete(kind, id, decide);
  }

  /** Delete a character or location, rewriting every document that referred to it. */
  deleteEntity(
    kind: 'character' | 'location',
    id: string,
    decide: (world: EntityWorld) => EntityOp,
  ): Promise<SceneEditResult> {
    return this.storyPart.deleteEntity(kind, id, decide);
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
    return this.storyPart.shotOrder(sceneId, shot, after);
  }

  async previewLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; assigned: number }> {
    return this.storyPart.previewLineIds(sceneId);
  }

  /**
   * Persist the ids reading already allocated as `[[line:]]` marks. Nothing about the model
   * changes — the ids are the same ones `splitScenes` handed out — so this writes the prose
   * files and reports; what it buys is that a later insertion can no longer shift them.
   */
  async writeLineIds(
    sceneId?: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.storyPart.writeLineIds(sceneId);
  }

  async previewImport(): Promise<{ ok: boolean; message: string }> {
    return this.storyPart.previewImport();
  }

  /**
   * Convert a `screenplay/*.fountain` project into one chunk per scene — the `vngen import`
   * equivalent. The screenplay is moved aside rather than deleted, and moved last: while it is
   * still a `.fountain` the project reports it on every load, so the rename finishes the import.
   */
  async importScreenplay(): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.storyPart.importScreenplay();
  }

  /**
   * One scene's script and shots for the coverage timeline. Shots come off disk: a model built
   * from inputs carries none, and the persisted decomposition is the one the run illustrated.
   */
  async sceneCoverage(sceneId: string): Promise<SceneCoverage> {
    return this.storyPart.sceneCoverage(sceneId);
  }

  /**
   * Rewrite one shot's coverage. The rule is `@vn/scriptedit`'s `setCoverage`, so the timeline's mid-drag
   * preview and this write cannot disagree; only `coversLines` is touched, and `buildShotPrompt`
   * ignores it, so no task rehashes and no generated art is invalidated.
   */
  async setCoverage(
    sceneId: string,
    shotId: string,
    lines: readonly string[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setCoverage(sceneId, shotId, lines);
  }

  async sceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<(scenes: Map<string, Scene>) => SceneOutfitOp> {
    return this.storyPart.sceneOutfit(sceneId, character, outfit);
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
    return this.storyPart.previewSceneOutfit(sceneId, character, outfit);
  }

  async previewShotOutfit(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotOutfit(sceneId, shotId, character, outfit);
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
    return this.storyPart.setShotOutfit(sceneId, shotId, character, outfit);
  }

  async previewShotVariant(
    sceneId: string,
    shotId: string,
    variant: string,
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotVariant(sceneId, shotId, variant);
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
    return this.storyPart.setShotVariant(sceneId, shotId, variant);
  }

  async previewShotSubjects(
    sceneId: string,
    shotId: string,
    subjects: readonly string[],
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotSubjects(sceneId, shotId, subjects);
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
    return this.storyPart.setShotSubjects(sceneId, shotId, subjects);
  }

  async previewShotCast(sceneId: string, shotId: string, required: boolean): Promise<ShotOutfitOp> {
    return this.storyPart.previewShotCast(sceneId, shotId, required);
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
    return this.storyPart.requireShotCast(sceneId, shotId, required);
  }

  async previewPanels(
    sceneId: string,
    shotId: string,
    panels: readonly PagePanel[],
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewPanels(sceneId, shotId, panels);
  }

  /**
   * Replace one shot's panels. Every part of a panel is in the page's prompt, so the page re-hashes
   * and the next run draws it again; an empty list makes the shot a single frame.
   */
  async setPanels(
    sceneId: string,
    shotId: string,
    panels: readonly PagePanel[],
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setPanels(sceneId, shotId, panels);
  }

  async previewBubbles(
    sceneId: string,
    shotId: string,
    bubbles: readonly PanelBubble[],
  ): Promise<ShotOutfitOp> {
    return this.storyPart.previewBubbles(sceneId, shotId, bubbles);
  }

  /** Restates where the runner draws one page's bubbles; nothing re-hashes. */
  async setBubbles(
    sceneId: string,
    shotId: string,
    bubbles: readonly PanelBubble[],
    timing?: PhaseTimer,
    assertUndoInput?: (path: string, text: string) => void,
  ) {
    return this.storyPart.setBubbles(sceneId, shotId, bubbles, timing, assertUndoInput);
  }

  async previewSheet(sceneId: string, shotId: string, sheet: string): Promise<SheetsOp<Shot>> {
    return this.storyPart.previewSheet(sceneId, shotId, sheet);
  }

  /** Puts one shot in a staging-sheet group, or takes it out; every member re-keys. */
  async setSheet(
    sceneId: string,
    shotId: string,
    sheet: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setSheet(sceneId, shotId, sheet);
  }

  async previewSheetGroup(
    sceneId: string,
    args: { sheet: string; seed?: number; notes?: string },
  ): Promise<SheetsOp<Shot>> {
    return this.storyPart.previewSheetGroup(sceneId, args);
  }

  /** Sets a sheet group's seed and notes; a new seed is how a sheet is rerolled. */
  async setSheetGroup(
    sceneId: string,
    args: { sheet: string; seed?: number; notes?: string },
  ): Promise<{ ok: boolean; message: string; written: string[]; coverage?: SceneCoverage }> {
    return this.storyPart.setSheetGroup(sceneId, args);
  }

  async previewNewShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ): Promise<NewShotOp> {
    return this.storyPart.previewNewShot(sceneId, lines, framing, subjects);
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
    return this.storyPart.newShot(sceneId, lines, framing, subjects);
  }

  async previewDeleteShot(sceneId: string, shotId: string): Promise<DeleteShotOp> {
    return this.storyPart.previewDeleteShot(sceneId, shotId);
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
    return this.storyPart.deleteShot(sceneId, shotId);
  }
}
