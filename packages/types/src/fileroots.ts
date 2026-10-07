/**
 * The folders the document tree's file commands may create, move, copy and delete in, and the
 * path rule over them. It is here rather than in the desktop app because `vnauthor`'s file tools
 * must refuse the same paths, and a package cannot import an app.
 */

/**
 * The folders file commands may write under: the author's own, where nothing is read by a fixed
 * path except the entity sheets the identity rule protects.
 */
export const FILE_ROOTS: readonly string[] = ['wiki', 'characters', 'locations', 'archive'];

/** Why a path outside {@link FILE_ROOTS} is refused. */
export const ROOTS_REFUSAL =
  'Files can be created, moved, renamed and deleted only under wiki/, characters/, locations/ ' +
  'and archive/. scenes/ is written by the story commands.';

/**
 * Whether a path is a folder something is put into, or an item that is created, moved or renamed.
 * A root such as `wiki` can be the first but never the second.
 */
export type PathRole = 'folder' | 'item';

/**
 * Answers why a file command must refuse `path`, or undefined when it is inside
 * {@link FILE_ROOTS}. A root itself is accepted as a `folder` and refused as an `item`, because
 * moving, renaming or deleting `wiki/` would take the whole story bible with it.
 */
export function rootProblem(path: string, role: PathRole = 'item'): string | undefined {
  const rel = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (rel === '') return ROOTS_REFUSAL;
  const segments = rel.split('/');
  if (/^[a-z]:/i.test(rel) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return `${path} is not a path inside the project.`;
  }
  const root = segments[0]!;
  if (!FILE_ROOTS.includes(root)) return ROOTS_REFUSAL;
  if (role === 'item' && segments.length === 1) {
    return `${root}/ is one of the project's own folders; it cannot be created, moved, renamed or deleted.`;
  }
  return undefined;
}
