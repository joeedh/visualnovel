/**
 * The order a project's repos commit in. Nested repos go first, so the repo containing them
 * stages each one's new HEAD as its gitlink rather than the previous one. Also its own entry,
 * `@vn/git/depth`, because `@vn/commands` reaches the renderer bundle and the barrel pulls in
 * `node:child_process`.
 */

/** Counts the segments of `path`; `.` and `..` are not resolved. */
function depthOf(path: string): number {
  return path.replace(/[\\/]+$/, '').split(/[\\/]+/).length;
}

/** Sorts a copy of `items` deepest path first, keeping the given order among equal depths. */
export function byDepth<T>(items: readonly T[], root: (item: T) => string): T[] {
  return [...items].sort((a, b) => depthOf(root(b)) - depthOf(root(a)));
}
