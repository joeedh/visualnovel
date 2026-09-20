/**
 * The path a picture is written into prose as, and the asset such a path names. Prose keeps a
 * document-relative path to the stored file rather than a `vnasset://` url, so a markdown viewer
 * over the same checkout draws the picture too; the app maps it back when it renders.
 */
import { relativePath, resolvePath } from '../doctree/docpath.js';

/** The two roots stored bytes live under (`docs/reference/asset-stores.md`), as workspace paths. */
const ROOTS = ['assets/objects/', 'vngen/build/assets/'];

/** The picture an `src` resolves to: the file's name under one of the roots, split at its dot. */
export interface PictureRef {
  hash: string;
  ext: string;
}

/** The path from the directory of `docPath` to `file`, both workspace-relative and forward-slashed. */
export function pictureSrc(docPath: string, file: string): string {
  return relativePath(docPath, file);
}

/**
 * The stored asset a `src` written in `docPath` names, or `undefined` for a url, an absolute
 * path, a path climbing out of the workspace, or a file under neither root.
 */
export function pictureAsset(docPath: string, src: string): PictureRef | undefined {
  const path = resolvePath(docPath, src);
  const root = path === undefined ? undefined : ROOTS.find((r) => path.startsWith(r));
  if (path === undefined || root === undefined) return undefined;
  const name = /^([^/]+)\.([^./]+)$/.exec(path.slice(root.length));
  const [, hash, ext] = name ?? [];
  return hash !== undefined && ext !== undefined ? { hash, ext } : undefined;
}
