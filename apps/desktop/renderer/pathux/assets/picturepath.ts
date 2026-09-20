/**
 * The path a picture is written into prose as, and the asset such a path names. Prose keeps a
 * document-relative path to the stored file rather than a `vnasset://` url, so a markdown viewer
 * over the same checkout draws the picture too; the app maps it back when it renders.
 */

/** The two roots stored bytes live under (`docs/reference/asset-stores.md`), as workspace paths. */
const ROOTS = ['assets/objects/', 'vngen/build/assets/'];

/** The picture an `src` resolves to: the file's name under one of the roots, split at its dot. */
export interface PictureRef {
  hash: string;
  ext: string;
}

/** The path from the directory of `docPath` to `file`, both workspace-relative and forward-slashed. */
export function pictureSrc(docPath: string, file: string): string {
  const from = dirOf(docPath);
  const to = file.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}

/**
 * The stored asset a `src` written in `docPath` names, or `undefined` for a url, an absolute
 * path, a path climbing out of the workspace, or a file under neither root.
 */
export function pictureAsset(docPath: string, src: string): PictureRef | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return undefined;
  const parts = dirOf(docPath);
  for (const part of src.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  const path = parts.join('/');
  const root = ROOTS.find((r) => path.startsWith(r));
  if (root === undefined) return undefined;
  const name = /^([^/]+)\.([^./]+)$/.exec(path.slice(root.length));
  const [, hash, ext] = name ?? [];
  return hash !== undefined && ext !== undefined ? { hash, ext } : undefined;
}

function dirOf(docPath: string): string[] {
  const parts = docPath.split('/');
  parts.pop();
  return parts.filter((p) => p !== '');
}
