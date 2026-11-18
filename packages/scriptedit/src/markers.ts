/**
 * The marker write path: `[[choice:]]`, `[[next:]]` and `[[outfit:]]` edits, planned across every
 * file they touch and then applied. `applySceneMarkerEdit` does the line rewrite; this module fans
 * out over the sources.
 */
import { contract } from '@vn/contracts';
import { applySceneMarkerEdit, type SceneMarkerEdit } from '@vn/model';
import { writeFileAtomic } from '@vn/util';
import { conflictedRefusal } from './conflicted.js';
import type { SceneSource } from './sources.js';

export const scriptSceneEditAllOrNothing = contract({
  id      : 'script.sceneEditAllOrNothing',
  rule: 'A scene edit that spans several chunk files is computed and proved in full before any file is written, and an existing chunk keeps its front-matter block byte for byte; only the body is rewritten.',
  prevents:
    'A splice refused on the third file leaving the first two already changed, and a re-serialized YAML block silently dropping the comments the author wrote in it.',
  subjects: [
    'module:packages/scriptedit/src/markers.ts',
    'function:packages/scriptedit/src/markers.ts#planMarkerEdit',
    'function:packages/scriptedit/src/markers.ts#applyMarkerPlan',
    'function:packages/scriptedit/src/apply.ts#proveScenes',
    'function:packages/scriptedit/src/apply.ts#planSceneEdit',
    'function:packages/scriptedit/src/sources.ts#chunkText',
  ],
  see     : ['docs/plans/archive/INDEX.md#scene-chunk-files'],
  detail:
    'Deciding is split from writing for both write paths: `planMarkerEdit` and `planSceneEdit` ' +
    "touch nothing, so a command's `check` and its `run` ask the same function, and the apply " +
    'step writes a plan that already proved itself. The front-matter block is spliced back from ' +
    "`splitFrontMatter`'s prefix rather than re-serialized.",
});

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

  const conflicted = conflictedRefusal(
    sources,
    [...groups.keys()].map((s) => s.id),
  );
  if (conflicted !== undefined) return { ok: false, message: conflicted };

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
