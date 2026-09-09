/**
 * The vocabulary a command's `affects` list is drawn from, and the two predicates that read it.
 *
 * A declaration names subtrees of the project a command may write, workspace-relative and
 * forward-slashed — the form `CommandRecord.written`, `checkWrittenScope` and `DocNode.path`
 * already use. The vocabulary is closed so that a typo (`scenes` misspelled) is a test failure
 * rather than a declaration nothing writes.
 *
 * This lives in `shared/` beside `normalizePath`, which it reuses, and beside the exclusion list
 * `snapshotted` reads. The predicate and that list must answer the same question about the same
 * paths, so they may not sit in two modules that can drift.
 */
import { normalizePath } from './writes.js';

/**
 * What an undo snapshot leaves out, as root-relative paths. Everything else under the project
 * root is the document class, apart from the media files `@vn/commands` skips wherever they sit.
 *
 * `build/` is content-addressed and `state/` is an append-only log — rolling either back would
 * throw away work a later run has to pay for again, and excluding them is also what keeps a
 * `pipeline.run` between two edits from reading as workspace drift. `assets/objects` is the base
 * store, which is the same class of thing, and pruning the walk there is worth the entry even
 * though its bytes are media. `keys/` holds credentials, which no undo may write over or delete,
 * and the session file moves on every pane drag.
 */
export const UNDO_EXCLUDES = [
  'vngen/build',
  'vngen/state',
  'assets/objects',
  'keys',
  '.vnstudio/session.json',
];

/**
 * The user-level configuration directory (`userConfigDir` in `@vn/config`), which sits outside
 * every workspace. Four commands write there and no workspace-relative path can name it, so it
 * gets a spelling no real path can collide with. A subtree under it is written `<user>/plugins`.
 */
export const USER_ROOT = '<user>';

/**
 * Directories a command may declare, at the project root. `keys` is here because `project.setKey`
 * exists to write it; the consequence of declaring it is `undoable: false`, since `keys` is
 * excluded from every snapshot.
 */
export const AFFECTS_DIRS = [
  'characters',
  'locations',
  'wiki',
  'scenes',
  'screenplay',
  'archive',
  'assets',
  'vngen',
  '.vnstudio',
  '.aiagent',
  '.github',
  'keys',
];

/** Files a command may declare, at the project root, none of which is under a directory root. */
export const AFFECTS_FILES = [
  'project.yaml',
  'screenplay.fountain',
  'AICONTEXT.generated.md',
  '.gitignore',
  '.gitattributes',
];

/** Every root a declared prefix must be, or be under. */
export const AFFECTS_ROOTS = [...AFFECTS_DIRS, ...AFFECTS_FILES, USER_ROOT];

/**
 * Every workspace root except `keys`, which only `project.setKey` writes.
 *
 * Three commands take their destination from the caller rather than fixing one, so their truthful
 * upper bound is nearly the whole vocabulary: `doc.rename`, `doc.write` and `agent.run`. Declaring
 * that carries little information, and the closed vocabulary is what rules out the worse case of
 * declaring the project root.
 */
export const ANY_DOCUMENT: readonly string[] = [
  ...AFFECTS_DIRS.filter((dir) => dir !== 'keys'),
  ...AFFECTS_FILES,
];

/**
 * {@link ANY_DOCUMENT} without `scenes`, which has one validated writer and is refused by every
 * whole-file surface. `doc.write` and `doc.rename` take this one.
 */
export const ANY_UNGUARDED_DOCUMENT: readonly string[] = ANY_DOCUMENT.filter(
  (dir) => dir !== 'scenes',
);

/** Is `path` at or under `prefix`? Neither may carry a trailing slash. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Is this a legal declaration? A prefix is one of the roots or something under one, already
 * normalized: no backslash, no leading `./`, no trailing slash, and not empty. A malformed entry
 * is refused rather than repaired, so two declarations of one subtree cannot differ textually.
 */
export function declarable(prefix: string): boolean {
  if (prefix === '' || prefix !== normalizePath(prefix) || prefix.endsWith('/')) return false;
  return AFFECTS_ROOTS.some((root) => under(prefix, root));
}

/**
 * Would an undo snapshot hold this prefix? False for a prefix that is an exclusion, for one
 * nested inside an exclusion, and for every `<user>` prefix, which no workspace snapshot reaches.
 *
 * A prefix that merely contains an exclusion answers true: `vngen` holds `vngen/work`, which is
 * snapshotted, as well as the two excluded subtrees under it.
 */
export function snapshotted(prefix: string): boolean {
  if (under(prefix, USER_ROOT)) return false;
  return !UNDO_EXCLUDES.some((exclude) => under(prefix, exclude));
}

/**
 * Does one of `prefixes` cover `path`? The path is normalized first and a trailing slash is
 * stripped, because a command may report a directory: `story.decomposeAll` writes
 * `vngen/work/shots/`.
 */
export function covers(prefixes: readonly string[], path: string): boolean {
  const target = normalizePath(path).replace(/\/+$/, '');
  if (target === '') return false;
  return prefixes.some((prefix) => under(target, prefix));
}
