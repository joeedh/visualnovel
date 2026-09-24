/**
 * The path rules of the document tree's file commands (`doc.mkdir`, `doc.newFile`), decided
 * without touching the disk. Main's `FilesPart` runs them before its own disk rules, and the
 * renderer runs `rootProblem` to grey a New folder… or New file… entry whose folder the commands
 * would refuse, since a form entry is never checked before the menu opens.
 */
import { skillTierPath } from './editors.js';
import { normalizePath } from './writes.js';

/**
 * The folders file commands may write under: the author's own, where nothing is read by a fixed
 * path except the entity sheets the identity rule protects.
 */
export const FILE_ROOTS: readonly string[] = ['wiki', 'characters', 'locations', 'archive'];

/** Why a path outside {@link FILE_ROOTS} is refused. */
export const ROOTS_REFUSAL =
  'Files can be created, moved and renamed only under wiki/, characters/, locations/ and ' +
  'archive/. scenes/ is written by the story commands.';

/** Device names Windows reserves, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Characters Windows refuses in a file name, besides the control characters. */
const FORBIDDEN = '/\\<>:"|?*';

/**
 * Why `name` cannot name a file or folder, or undefined when it can. The rule is Windows',
 * because a collaborator may be on Windows even when the author is not.
 */
export function fileNameProblem(name: string): string | undefined {
  if (name === '') return 'Type a name for it.';
  if (name === '.' || name === '..') return `"${name}" is not a name a file or folder can have.`;
  const bad = [...name].find((ch) => FORBIDDEN.includes(ch) || ch.charCodeAt(0) < 32);
  if (bad !== undefined) {
    const shown = bad.charCodeAt(0) < 32 ? 'a control character' : `"${bad}"`;
    return `"${name}" contains ${shown}, which Windows does not allow in a file name.`;
  }
  if (/[. ]$/.test(name)) {
    return `"${name}" ends in a dot or a space, which Windows removes from a file name.`;
  }
  if (RESERVED.test(name)) return `"${name}" is a device name Windows reserves.`;
  return undefined;
}

/**
 * Whether a path is a folder something is put into, or an item that is created, moved or renamed.
 * A root such as `wiki` can be the first but never the second.
 */
export type PathRole = 'folder' | 'item';

/**
 * Why a file command must refuse `path`, or undefined when it is inside {@link FILE_ROOTS}. A
 * root itself is accepted as a `folder` and refused as an `item`, because moving or renaming
 * `wiki/` would move the whole story bible.
 */
export function rootProblem(path: string, role: PathRole = 'item'): string | undefined {
  const rel = normalizePath(path).replace(/\/+$/, '');
  const tier = skillTierPath(rel)?.tier;
  if (tier === 'user' || tier === 'builtin') {
    return `${rel} is in a ${tier} skill, which is edited in the Skills pane; clone it into the project to change a copy.`;
  }
  if (rel === '') return ROOTS_REFUSAL;
  const segments = rel.split('/');
  if (/^[a-z]:/i.test(rel) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return `${path} is not a path inside the project.`;
  }
  const root = segments[0]!;
  if (!FILE_ROOTS.includes(root)) return ROOTS_REFUSAL;
  if (role === 'item' && segments.length === 1) {
    return `${root}/ is one of the project's own folders; it cannot be created, moved or renamed.`;
  }
  return undefined;
}

/** Where a new file or folder named `name` inside `parent` goes, or why it cannot. */
export function planCreate(
  parent: string,
  name: string,
): { ok: true; parent: string; path: string } | { ok: false; reason: string } {
  const folder = normalizePath(parent).replace(/\/+$/, '');
  const where = rootProblem(folder, 'folder');
  if (where) return { ok: false, reason: where };
  const named = fileNameProblem(name);
  if (named) return { ok: false, reason: named };
  return { ok: true, parent: folder, path: `${folder}/${name}` };
}
