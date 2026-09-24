/**
 * The path rules of the document tree's file commands (`doc.mkdir`, `doc.newFile`, `doc.move`,
 * `doc.copy`), decided without touching the disk. Main's `FilesPart` runs them before its own disk
 * rules, and the renderer runs `rootProblem` to grey a New folder… or New file… entry whose folder
 * the commands would refuse, since a form entry is never checked before the menu opens.
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

/** One item moved or copied: a file or a folder, workspace-relative at both ends. */
export interface FileMove {
  from: string;
  to: string;
}

type Planned = { ok: true; into: string; moves: FileMove[] } | { ok: false; reason: string };

const trimPath = (path: string): string => normalizePath(path).replace(/\/+$/, '');

/** Answers the last segment of a workspace-relative path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** `path` is `folder` or inside it, compared without regard to letter case. */
const within = (path: string, folder: string): boolean => {
  const p = path.toLowerCase();
  const f = folder.toLowerCase();
  return p === f || p.startsWith(`${f}/`);
};

/**
 * Applies the rules a move and a copy share: every path is an item under the four roots, `into` is a
 * folder under them, no folder goes into itself, and a path inside another listed folder is
 * dropped because that folder carries it.
 */
function planSources(paths: readonly string[], into: string, verb: string): Planned {
  const folder = trimPath(into);
  const where = rootProblem(folder, 'folder');
  if (where) return { ok: false, reason: where };
  const listed = [...new Set(paths.map(trimPath))];
  if (listed.length === 0)
    return { ok: false, reason: `Name at least one file or folder to ${verb}.` };
  for (const path of listed) {
    const problem = rootProblem(path, 'item');
    if (problem) return { ok: false, reason: problem };
    if (within(folder, path)) {
      return {
        ok    : false,
        reason: `${path} cannot be put into ${folder === path ? 'itself' : `${folder}, which is inside it`}.`,
      };
    }
  }
  const kept = listed.filter(
    (path) => !listed.some((other) => other !== path && within(path, other)),
  );
  return {
    ok   : true,
    into : folder,
    moves: kept.map((from) => ({ from, to: `${folder}/${baseName(from)}` })),
  };
}

/**
 * Where each of `paths` goes when moved into `into`, or why the move is refused. `name`, which is
 * allowed with one path only, gives the item a new name at its destination; a move into the folder
 * the item is already in is then a rename. A rename that changes only letter case is refused,
 * because on Windows and macOS undoing it would write the old name and then delete the new one,
 * which is the same file.
 */
export function planMove(paths: readonly string[], into: string, name = ''): Planned {
  const planned = planSources(paths, into, 'move');
  if (!planned.ok) return planned;
  if (name !== '') {
    if (planned.moves.length !== 1) {
      return { ok: false, reason: 'A new name can be given only when one item is moved.' };
    }
    const named = fileNameProblem(name);
    if (named) return { ok: false, reason: named };
    planned.moves[0]!.to = `${planned.into}/${name}`;
  }
  const seen = new Map<string, string>();
  for (const { from, to } of planned.moves) {
    if (to === from) {
      return {
        ok    : false,
        reason:
          name === ''
            ? `${from} is already in ${planned.into}.`
            : `${from} is already called ${name}.`,
      };
    }
    if (to.toLowerCase() === from.toLowerCase()) {
      return {
        ok    : false,
        reason:
          `${from} and ${to} differ only in letter case, which Windows and macOS treat as one ` +
          'name, so undoing the rename would delete the file. Rename it to a different name, ' +
          'then to the one you want.',
      };
    }
    const key = baseName(to).toLowerCase();
    const clash = seen.get(key);
    if (clash !== undefined) {
      return {
        ok    : false,
        reason: `${clash} and ${from} have the same name, so they cannot both go into ${planned.into}.`,
      };
    }
    seen.set(key, from);
  }
  return planned;
}

/**
 * The items `paths` copies into `into`, each still under its own name; `FilesPart` renames a
 * copy whose name is taken with {@link copyName}. Unlike a move, a copy into the folder an item is
 * already in is allowed, since that is how a page is duplicated.
 */
export function planCopy(paths: readonly string[], into: string): Planned {
  return planSources(paths, into, 'copy');
}

/**
 * A name for a copy of `name` that `taken` does not hold: the name itself, then `-copy` before the
 * extension, then `-copy-2`, `-copy-3`. A folder has no extension, so `lore` becomes `lore-copy`.
 * No spaces or parentheses, because a link to `a (copy).md` does not parse as a markdown link.
 */
export function copyName(name: string, folder: boolean, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = folder ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${stem}-copy${n === 1 ? '' : `-${n}`}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Where `path` is after `moves`: its own entry's `to`, the same place under a moved folder, or unchanged. */
export function remapPath(path: string, moves: readonly FileMove[]): string {
  for (const { from, to } of moves) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  }
  return path;
}
