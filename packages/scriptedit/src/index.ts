/**
 * `@vn/scriptedit` — the scene-edit decision rules, in a package both the desktop app and the
 * authoring agent can import.
 *
 * The rules were in `apps/desktop/src/shared/`, which made them unreachable from `@vn/authoring`
 * (a package may not import an app), so the agent's `edit_scene` had no way to give the same
 * answer as the desktop's `story.*` commands. See `docs/plans/archive/INDEX.md#scene-edit-package`.
 *
 * Both halves of a scene edit are covered: `lineops` decides which edits are legal and
 * `branchops` decides which wires are.
 *
 * This entry is deliberately pure and browser-safe: the renderer runs `moveLine` to preview a
 * drag, so a bundle for the browser must be able to reach the rules. The write path, which reads
 * and writes files, is `@vn/scriptedit/write` — a separate entry a browser bundle cannot pull in
 * by accident.
 */

export {
  removeChoice,
  setChoice,
  setNext,
  spliceScene,
  type BranchOp,
  type SceneMap,
} from './branchops.js';
export {
  deleteLine,
  deleteLines,
  deleteScene,
  insertLine,
  insertLines,
  isSpeakable,
  mergeScene,
  moveLine,
  newScene,
  sceneIdOf,
  setHeading,
  setLineText,
  setSpeaker,
  splitScene,
  type AppliedLineOp,
  type LineOp,
  type ScriptState,
} from './lineops.js';
export { moveShot, planShotMove, type PositionedShot, type ShotMove } from './shotorder.js';
export {
  resolveDrag,
  range,
  runsOf,
  setCoverage,
  spansFor,
  type CoverLine,
  type CoverShot,
  type Coverage,
  type CoverageOp,
  type CoverageRow,
  type Edge,
  type Segment,
  type ShotSpan,
} from './coverage.js';
export {
  deleteShot,
  derivedNextShot,
  newShot,
  type DeleteShotOp,
  type NewShotOp,
  type ShotBoard,
  type ShotScene,
} from './shotcreate.js';
export {
  setSceneOutfit,
  setShotOutfit,
  wardrobesOf,
  type SceneOutfitOp,
  type ShotOutfitOp,
  type Wardrobe,
  type WardrobeMap,
} from './outfits.js';
export { setShotVariant } from './variants.js';
export {
  scenesTouchedBy,
  shotFallout,
  type ShotFallout,
  type ShotsByScene,
} from './shotfallout.js';
