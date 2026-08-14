/**
 * The marker write path: `[[choice:]]`, `[[next:]]` and `[[outfit:]]` edits, planned across every
 * file they touch and then applied.
 *
 * Split from deciding for the same reason a prose edit is: a set of edits spanning three chunks and
 * refused on the third must leave the first two exactly as they were, so every patch is computed
 * before any is written. `applySceneMarkerEdit` does the surgical line rewrite; this is only the
 * fan-out over sources and the all-or-nothing.
 */
import { applySceneMarkerEdit, type SceneMarkerEdit } from '@vn/model';
import { writeFileAtomic } from '@vn/util';
import type { SceneSource } from './sources.js';

/** One file's patched bytes, waiting to be written. */
export interface MarkerPatch {
  source: SceneSource;
  text: string;
}

/**
 * The patches a marker edit implies, or why it cannot be made. An empty `patches` is a success —
 * the scenes already say what they were asked to say — and is what lets a caller distinguish
 * "written" from "already so" without diffing anything.
 */
export type MarkerPlan = { ok: true; patches: MarkerPatch[] } | { ok: false; message: string };

/** Plan a marker edit over the sources the model was built from. Pure: nothing is written. */
export function planMarkerEdit(
  sources: readonly SceneSource[],
  edits: readonly SceneMarkerEdit[],
): MarkerPlan {
  if (sources.length === 0)
    return { ok: false, message: 'This project has no scene files to edit.' };

  const groups = new Map<SceneSource, SceneMarkerEdit[]>();
  for (const edit of edits) {
    const source = sources.find((s) => s.id === edit.sceneId);
    if (!source) return { ok: false, message: `No file holds scene "${edit.sceneId}".` };
    groups.set(source, [...(groups.get(source) ?? []), edit]);
  }

  const patches: MarkerPatch[] = [];
  for (const [source, group] of groups) {
    const patched = applySceneMarkerEdit(source.script, group, { sceneId: source.id });
    if (patched.diagnostics.length > 0) {
      return { ok: false, message: patched.diagnostics.map((d) => d.message).join(' ') };
    }
    if (patched.text !== source.script) patches.push({ source, text: patched.text });
  }
  return { ok: true, patches };
}

/** Write a plan's patches, front-matter spliced back byte-exactly. Returns the files written. */
export async function applyMarkerPlan(patches: readonly MarkerPatch[]): Promise<string[]> {
  for (const { source, text } of patches) {
    await writeFileAtomic(source.file, source.prefix + text);
  }
  return patches.map((p) => p.source.file);
}
