import type { PhaseTimer } from '@vn/commands';
import type {
  BranchOp,
  EntityOp,
  EntityWorld,
  LineOp,
  ScriptState,
  SceneOutfitOp,
} from '@vn/scriptedit';
import type { PagePanel, PanelBubble, Scene } from '@vn/types';
import type { WorkspaceSession } from './core.js';
import * as branches from './story/branches.js';
import * as bubbles from './story/bubbles.js';
import * as coverage from './story/coverage.js';
import * as imports from './story/import.js';
import * as scene from './story/scene.js';
import * as shotedit from './story/shotedit.js';
import * as shotlife from './story/shotlife.js';

/**
 * The `story.*` writes and their previews. Each method delegates to a module under `story/`,
 * grouped by what the code edits: branch markers, scene prose, shot coverage, per-shot fields,
 * shot lifecycle and sheets, bubbles, and the Fountain import.
 */
export class StoryPart {
  constructor(private readonly session: WorkspaceSession) {}

  storyGraph() {
    return branches.storyGraph(this.session);
  }

  editBranches(decide: (scenes: Map<string, Scene>) => BranchOp) {
    return branches.editBranches(this.session, decide);
  }

  scriptState() {
    return scene.scriptState(this.session);
  }

  previewSceneEdit(decide: (state: ScriptState) => LineOp) {
    return scene.previewSceneEdit(this.session, decide);
  }

  sceneEditRemovals(decide: (state: ScriptState) => LineOp) {
    return scene.sceneEditRemovals(this.session, decide);
  }

  editScene(decide: (state: ScriptState) => LineOp) {
    return scene.editScene(this.session, decide);
  }

  previewEntityDelete(
    kind: 'character' | 'location',
    id: string,
    decide: (world: EntityWorld) => EntityOp,
  ) {
    return scene.previewEntityDelete(this.session, kind, id, decide);
  }

  deleteEntity(
    kind: 'character' | 'location',
    id: string,
    decide: (world: EntityWorld) => EntityOp,
  ) {
    return scene.deleteEntity(this.session, kind, id, decide);
  }

  shotOrder(sceneId: string, shot: string, after: string) {
    return scene.shotOrder(this.session, sceneId, shot, after);
  }

  previewLineIds(sceneId?: string) {
    return scene.previewLineIds(this.session, sceneId);
  }

  writeLineIds(sceneId?: string) {
    return scene.writeLineIds(this.session, sceneId);
  }

  previewImport() {
    return imports.previewImport(this.session);
  }

  importScreenplay() {
    return imports.importScreenplay(this.session);
  }

  sceneCoverage(sceneId: string) {
    return coverage.sceneCoverage(this.session, sceneId);
  }

  setCoverage(sceneId: string, shotId: string, lines: readonly string[]) {
    return coverage.setShotCoverage(this.session, sceneId, shotId, lines);
  }

  sceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<(scenes: Map<string, Scene>) => SceneOutfitOp> {
    return branches.sceneOutfit(this.session, sceneId, character, outfit);
  }

  previewSceneOutfit(sceneId: string, character: string, outfit: string) {
    return branches.previewSceneOutfit(this.session, sceneId, character, outfit);
  }

  previewShotOutfit(sceneId: string, shotId: string, character: string, outfit: string) {
    return shotedit.previewShotOutfit(this.session, sceneId, shotId, character, outfit);
  }

  setShotOutfit(sceneId: string, shotId: string, character: string, outfit: string) {
    return shotedit.setShotOutfit(this.session, sceneId, shotId, character, outfit);
  }

  previewShotVariant(sceneId: string, shotId: string, variant: string) {
    return shotedit.previewShotVariant(this.session, sceneId, shotId, variant);
  }

  setShotVariant(sceneId: string, shotId: string, variant: string) {
    return shotedit.setShotVariant(this.session, sceneId, shotId, variant);
  }

  previewShotSubjects(sceneId: string, shotId: string, subjects: readonly string[]) {
    return shotedit.previewShotSubjects(this.session, sceneId, shotId, subjects);
  }

  setShotSubjects(sceneId: string, shotId: string, subjects: readonly string[]) {
    return shotedit.setShotSubjects(this.session, sceneId, shotId, subjects);
  }

  previewShotCast(sceneId: string, shotId: string, required: boolean) {
    return shotedit.previewShotCast(this.session, sceneId, shotId, required);
  }

  requireShotCast(sceneId: string, shotId: string, required: boolean) {
    return shotedit.requireCast(this.session, sceneId, shotId, required);
  }

  previewPanels(sceneId: string, shotId: string, panels: readonly PagePanel[]) {
    return shotedit.previewPanels(this.session, sceneId, shotId, panels);
  }

  setPanels(sceneId: string, shotId: string, panels: readonly PagePanel[]) {
    return shotedit.setShotPanels(this.session, sceneId, shotId, panels);
  }

  previewBubbles(sceneId: string, shotId: string, list: readonly PanelBubble[]) {
    return bubbles.previewBubbles(this.session, sceneId, shotId, list);
  }

  setBubbles(
    sceneId: string,
    shotId: string,
    list: readonly PanelBubble[],
    timing?: PhaseTimer,
    assertUndoInput?: (path: string, text: string) => void,
  ) {
    return bubbles.setBubbles(this.session, sceneId, shotId, list, timing, assertUndoInput);
  }

  previewSheet(sceneId: string, shotId: string, sheet: string) {
    return shotlife.previewSheet(this.session, sceneId, shotId, sheet);
  }

  setSheet(sceneId: string, shotId: string, sheet: string) {
    return shotlife.setSheet(this.session, sceneId, shotId, sheet);
  }

  previewSheetGroup(sceneId: string, args: { sheet: string; seed?: number; notes?: string }) {
    return shotlife.previewSheetGroup(this.session, sceneId, args);
  }

  setSheetGroup(sceneId: string, args: { sheet: string; seed?: number; notes?: string }) {
    return shotlife.setSheetGroup(this.session, sceneId, args);
  }

  previewNewShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ) {
    return shotlife.previewNewShot(this.session, sceneId, lines, framing, subjects);
  }

  newShot(
    sceneId: string,
    lines: readonly string[],
    framing: string,
    subjects: readonly string[] = [],
  ) {
    return shotlife.newShot(this.session, sceneId, lines, framing, subjects);
  }

  previewDeleteShot(sceneId: string, shotId: string) {
    return shotlife.previewDeleteShot(this.session, sceneId, shotId);
  }

  deleteShot(sceneId: string, shotId: string) {
    return shotlife.deleteShot(this.session, sceneId, shotId);
  }
}
