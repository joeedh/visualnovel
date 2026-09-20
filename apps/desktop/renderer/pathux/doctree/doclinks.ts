/**
 * Links between documents, as the Wiki pane completes and follows them. A link is an ordinary
 * markdown link to a document-relative path (`[Aiko](../aiko/character.md)`), never the `[[…]]`
 * the screenplay uses for markers; what a completion offers and what a click resolves are both
 * read out of the document tree, so a link can only name what the tree shows.
 */
import { pictureAsset } from '../assets/picturepath.js';
import { relativePath, resolvePath } from './docpath.js';
import type { DocNode } from '../../../src/shared/ipc.js';

/** How many rows a completion shows; the query narrows the rest. */
export const COMPLETION_ROWS = 8;

/** Every document in the tree a link can point at: the nodes with a markdown file behind them, one per path. */
export function linkTargets(roots: readonly DocNode[]): DocNode[] {
  const seen = new Set<string>();
  const out: DocNode[] = [];
  const walk = (nodes: readonly DocNode[]) => {
    for (const node of nodes) {
      if (node.path !== undefined && node.path.endsWith('.md') && !seen.has(node.path)) {
        seen.add(node.path);
        out.push(node);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * The targets a typed query keeps, at most `COMPLETION_ROWS`: a match on the name first, then on
 * the path, each in tree order. An empty query keeps the first rows of the tree.
 */
export function filterTargets(targets: readonly DocNode[], query: string): DocNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return targets.slice(0, COMPLETION_ROWS);
  const byName = targets.filter((t) => t.label.toLowerCase().includes(needle));
  const byPath = targets.filter(
    (t) => !byName.includes(t) && (t.path ?? '').toLowerCase().includes(needle),
  );
  return [...byName, ...byPath].slice(0, COMPLETION_ROWS);
}

/** The `href` a link from `docPath` to `target` is written with. */
export function linkHref(docPath: string, target: DocNode): string {
  return relativePath(docPath, target.path ?? '');
}

/**
 * What a link written in `docPath` points at, as a tree node a click can open: a stored picture
 * as an asset node, a document as its node in the tree, and `undefined` for a url or a path
 * that names neither.
 */
export function linkedNode(
  docPath: string,
  href: string,
  roots: readonly DocNode[],
): DocNode | undefined {
  const picture = pictureAsset(docPath, href);
  if (picture) return { id: `asset:${picture.hash}`, kind: 'asset', label: picture.hash };
  const path = resolvePath(docPath, href);
  return path === undefined ? undefined : linkTargets(roots).find((t) => t.path === path);
}
