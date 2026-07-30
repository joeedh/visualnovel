/**
 * `@vn/scriptedit` — the scene-edit decision rules and the write path that applies them,
 * in a package both the desktop app and the authoring agent can import.
 *
 * The rules were in `apps/desktop/src/shared/`, which made them unreachable from
 * `@vn/authoring` (a package may not import an app) — so the agent's `edit_scene` had no way
 * to be the same answer as the desktop's `story.*` commands. See
 * `docs/plans/scene-edit-package.md`.
 */

export {
  deleteLine,
  deleteScene,
  insertLine,
  mergeScene,
  moveLine,
  newScene,
  sceneIdOf,
  setLineText,
  setSpeaker,
  splitScene,
  type AppliedLineOp,
  type LineOp,
  type ScriptState,
} from './lineops.js';
export {
  scenesTouchedBy,
  shotFallout,
  type ShotFallout,
  type ShotsByScene,
} from './shotfallout.js';
