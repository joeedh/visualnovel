/**
 * `@vn/scriptedit/write` — the scene-edit write path, covering the files an edit targets and the
 * plan/apply pair that patches them.
 *
 * This is a second entry rather than part of the barrel because this half touches the filesystem
 * while the desktop renderer imports the rules (it runs `moveLine` to preview a drag). One barrel
 * over both would put `node:path` in a browser bundle. Only a host that writes files imports this
 * entry, and it must name the entry to get it.
 */

export { chunkText, scriptStateOf, sourcesOf, type SceneSource } from './sources.js';
export { applyMarkerPlan, planMarkerEdit, type MarkerPatch, type MarkerPlan } from './markers.js';
export {
  applyScenePlan,
  planSceneEdit,
  scenePlanMessage,
  type AppliedScenePlan,
  type SceneEditInput,
  type ScenePlan,
} from './apply.js';
