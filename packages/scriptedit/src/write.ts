/**
 * `@vn/scriptedit/write` — the scene-edit write path: the files an edit targets, and the plan/apply
 * pair that patches them.
 *
 * A second entry rather than part of the barrel because this half touches the filesystem, and the
 * desktop **renderer** imports the rules (it runs `moveLine` to preview a drag). One barrel over
 * both would put `node:path` in a browser bundle — which it did, until this split. A host that
 * writes names this entry; a browser bundle cannot reach it by accident.
 */

export { chunkText, scriptStateOf, sourcesOf, type SceneSource } from './sources.js';
export {
  applyScenePlan,
  planSceneEdit,
  scenePlanMessage,
  type AppliedScenePlan,
  type SceneEditInput,
  type ScenePlan,
} from './apply.js';
