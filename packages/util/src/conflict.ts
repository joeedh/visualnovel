/**
 * The markers git leaves in a file it merged line by line and could not finish. Here rather than
 * in `@vn/git` because the scene-edit rules refuse a marked scene, and they cannot import git.
 * Also its own entry, `@vn/util/conflict`, because `@vn/model` reaches the renderer bundle and
 * the barrel pulls in `node:crypto`.
 */

/** Whether `text` still holds the markers git leaves in a conflicted file. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(text);
}
