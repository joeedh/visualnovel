/**
 * The one refusal both planners share: no edit lands on a scene git left conflict markers in. A
 * marked scene still loads, but the parser reads `=======` as a page break and drops it, so the
 * first re-serialization would run the two sides together. The sentence names no pane, since
 * `vnauthor` runs the same rule and has none.
 */
import { hasConflictMarkers } from '@vn/util';
import type { SceneSource } from './sources.js';

/** The sentence a refused edit on a marked scene carries. */
export function conflictedSentence(id: string): string {
  return `scenes/${id}.md is waiting on a merge decision; decide it before editing it.`;
}

/**
 * The refusal for the first of `ids` whose source holds git's markers, or undefined when none
 * does. An id with no source is not conflicted.
 */
export function conflictedRefusal(
  sources: readonly SceneSource[],
  ids: Iterable<string>,
): string | undefined {
  for (const id of ids) {
    const source = sources.find((s) => s.id === id);
    if (source && hasConflictMarkers(source.prefix + source.script)) {
      return conflictedSentence(id);
    }
  }
  return undefined;
}
