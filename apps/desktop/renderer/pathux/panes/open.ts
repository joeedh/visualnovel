/**
 * Lets a surface open a document of its own. `routeFor` decides which editor answers and `view.ts`
 * does the pane arithmetic; this is the glue between them, so the tree, the wiki pane and the
 * script pane cannot disagree about where a clicked picture lands.
 *
 * This is deliberately not a method on {@link VnEditor}. `view.ts` imports the base class, so
 * reaching back the other way would close an import cycle the lint rule rejects.
 */
import type { DocNode } from '../../../src/shared/ipc.js';
import { exec } from '../app/bridge.js';
import { routeFor } from './route.js';
import type { VnScreen } from '../app/screen.js';
import { panesOf } from './view.js';

/**
 * Show whatever answers for `node`. Does nothing when no editor claims the node, because such a
 * click has already done its whole job by moving the selection.
 */
export function openNode(screen: VnScreen | undefined, node: DocNode): void {
  const route = routeFor({ node, panes: screen ? panesOf(screen) : [] });
  if (route.action !== 'open') return;
  void exec('view.open', { editor: route.editor, where: route.where, subject: route.subject });
}

/** Wraps a bare asset hash as a node. An asset strip carries hashes where the tree carries rows. */
export function assetNode(hash: string): DocNode {
  return { id: `asset:${hash}`, kind: 'asset', label: hash };
}
