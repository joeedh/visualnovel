/**
 * Which of a command's (or an agent turn's) writes concern the document a pane is showing.
 *
 * The two panes ask different questions, which is why this lives here rather than inline in either
 * editor. The wiki pane knows its own path and can compare directly. The script pane has only a
 * scene id, so a hit has to be derived from where a scene lives. Both lists arrive
 * workspace-relative and forward-slashed (`ToolResult.written`, `CommandRecord.written`), but a
 * path that took a detour through node's `path` on Windows comes back with backslashes, so nothing
 * here compares raw strings.
 */

/** Workspace-relative, forward-slashed, no `./` prefix — the shape both sides are compared in. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Did any of `written` name this exact document? */
export function touches(written: readonly string[], path: string): boolean {
  if (!path) return false;
  const target = normalizePath(path);
  return written.some((w) => normalizePath(w) === target);
}

/**
 * Did any of `written` name the file a scene lives in? One scene is one file — `scenes/<id>.md` —
 * so the id is enough; a chunk under any other name is not a scene this app can be showing.
 */
export function touchesScene(written: readonly string[], sceneId: string): boolean {
  if (!sceneId) return false;
  return touches(written, `scenes/${sceneId}.md`);
}

/**
 * Where generation graph documents live, workspace-relative.
 *
 * `vngen/work/`, not a bare `work/`: `ProjectPaths.work` is already under `vngen/`, so that is
 * what `graphPath` reports and what a `written` list carries. The same note sits on the guarded
 * directory map in `@vn/store`, which cannot be imported here — this module is bundled into the
 * renderer and that one reaches `node:fs`.
 */
export const GRAPH_DOCS_DIR = 'vngen/work/graphs';

/**
 * Where one generation graph's document lives. This is the key a pane looks its own document up
 * by in a version map, so it lives beside the matcher below rather than being spelled out again at
 * the call site: a matcher and a key that disagree would leave a pane reloading on writes it can
 * never recognize as its own.
 */
export function graphDocPath(slug: string): string {
  return `${GRAPH_DOCS_DIR}/${slug}.json`;
}

/** Did any of `written` name the file a generation graph lives in? `work/graphs/<slug>.json`. */
export function touchesGraph(written: readonly string[], slug: string): boolean {
  if (!slug) return false;
  return touches(written, graphDocPath(slug));
}
