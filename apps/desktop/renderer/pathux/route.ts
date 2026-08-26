/**
 * Which editor a clicked document-tree node opens, and where. Pure arithmetic over the claims
 * declared beside the editor names and a description of the mesh, so the answer to "why did this
 * click land in Shot Coverage" is a table lookup that can be tested without a screen.
 *
 * Routing stays in the renderer because only the mesh knows which panes exist; main answers
 * `view.*` optimistically and takes a correction back from `applyView`, and a second, main-side
 * notion of pane visibility would give two answers to one question.
 */
import { CLAIMS, type ClaimTier, type EditorId, type OpenWhere } from '../../src/shared/editors.js';
import type { DocNode } from '../../src/shared/ipc.js';
import { nodeKey } from './doctree.js';
import { NO_PANE, paneShowing, type Pane } from './panes.js';

export interface RouteRequest {
  node: DocNode;
  panes: readonly Pane[];
}

/**
 * What to do with the click. `select` is a node nothing claims (a grouping, or an entity with no
 * document behind it) for which publishing the selection was the whole act.
 */
export type Route =
  | { action: 'select' }
  | { action: 'open'; editor: EditorId; where: OpenWhere; subject: string };

/**
 * Which selection field an editor's subject comes from. A path, a hash and a graph name are not
 * interchangeable (pointing `docPath` at a `.png` would have the wiki editor `doc.read` a binary),
 * so an editor with no entry here has no subject, and the field it does not name is left alone.
 */
export const SUBJECT_OF: Partial<Record<EditorId, 'docPath' | 'assetHash' | 'graphSlug'>> = {
  wiki: 'docPath',
  skills: 'docPath',
  documents: 'docPath',
  asset: 'assetHash',
  gengraph: 'graphSlug',
};

interface Claimant {
  editor: EditorId;
  tier: ClaimTier;
  visible: boolean;
  /** Position in `EDITORS`, which is what makes the ordering total and therefore testable. */
  order: number;
}

/**
 * Computes where a click on this node should land. A claimant that is not visible falls back to
 * `elsewhere`. `paneElsewhere` reads `elsewhere` as the biggest pane that is not the one asking,
 * so the tree never opens something over itself, and this function needs no notion of which pane
 * the click came from.
 */
export function routeFor(req: RouteRequest): Route {
  const claimants: Claimant[] = [];
  for (const [order, editor] of CLAIMS.entries()) {
    const tier = editor.claims(req.node);
    if (!tier) continue;
    claimants.push({
      editor: editor.id,
      tier,
      visible: paneShowing(req.panes, editor.id) !== NO_PANE,
      order,
    });
  }
  if (claimants.length === 0) return { action: 'select' };

  claimants.sort(better);
  const winner = claimants[0] as Claimant;
  return {
    action: 'open',
    // A visible claimant is focused rather than opened twice, which `open(where='here')` already
    // does. A claimant that is not visible opens in a pane other than the one that asked
    where: winner.visible ? 'here' : 'elsewhere',
    editor: winner.editor,
    subject: subjectFor(winner.editor, req.node),
  };
}

/**
 * Visibility first, tier second, taken literally. A visible secondary claimant beats a hidden
 * primary one, so clicking a scene with Shot Coverage open and Script closed lands there. That is
 * what "a visible editor always outranks a hidden one" says, and it respects where the author is
 * already looking. Swapping the first two comparisons is the whole change if that is ever wrong.
 */
function better(a: Claimant, b: Claimant): number {
  if (a.visible !== b.visible) return a.visible ? -1 : 1;
  if (a.tier !== b.tier) return a.tier === 'primary' ? -1 : 1;
  return a.order - b.order;
}

/**
 * The one string `view.open` carries. An editor whose subject needs two fields (a shot is a scene
 * plus a shot) has no entry here and opens on the selection the click published instead, which is
 * why routing publishes first and opens second.
 */
function subjectFor(editor: EditorId, node: DocNode): string {
  switch (SUBJECT_OF[editor]) {
    case 'docPath':
      return node.path ?? '';
    case 'assetHash':
      return node.kind === 'asset' ? nodeKey(node) : '';
    case 'graphSlug':
      return node.boundGraph ?? '';
    default:
      return '';
  }
}
