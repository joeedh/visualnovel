/**
 * A surface opening a document of its own. The rule is `routeFor`'s and the pane arithmetic is
 * `view.ts`'s; this is the one line of glue between them, so the tree, the wiki pane and the
 * script pane cannot start disagreeing about where a clicked picture lands.
 *
 * It is deliberately not a method on {@link VnEditor}: the base class is imported *by* `view.ts`,
 * and reaching back the other way would close an import cycle the lint rule rejects.
 */
import type { DocNode } from '../../src/shared/ipc.js';
import { exec } from './bridge.js';
import { routeFor } from './route.js';
import type { VnScreen } from './screen.js';
import { panesOf } from './view.js';

/**
 * Show whatever answers for `node`. Silent when nothing claims it — a click that names no editor
 * has already done its whole job by moving the selection.
 */
export function openNode(screen: VnScreen | undefined, node: DocNode): void {
  const route = routeFor({ node, panes: screen ? panesOf(screen) : [] });
  if (route.action !== 'open') return;
  void exec('view.open', { editor: route.editor, where: route.where, subject: route.subject });
}

/** The node a bare hash stands for — what an asset strip has instead of a tree row. */
export function assetNode(hash: string): DocNode {
  return { id: `asset:${hash}`, kind: 'asset', label: hash };
}
