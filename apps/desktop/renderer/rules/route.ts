/**
 * Which editor a clicked document-tree node opens, and where. Pure arithmetic over the claims
 * declared beside the editor names and the list of editors on screen, so the answer to "why did
 * this click land in Shot Coverage" is a table lookup that can be tested without a screen.
 *
 * Routing stays in the renderer because only the mesh knows which panes exist; main answers
 * `view.*` optimistically and takes a correction back from `applyView`, and a second, main-side
 * notion of pane visibility would give two answers to one question. `panes/route.ts` reads the
 * mesh and calls this; the rule modules call it with the situation's `visible` list, so both of
 * its answers are in the derived model.
 */
import { CLAIMS, type ClaimTier, type EditorId, type OpenWhere } from '../../src/shared/editors.js';
import type { DocNode } from '../../src/shared/ipc.js';
import { nodeKey, splitShot } from './selection.js';

export interface RouteRequest {
  node: DocNode;
  /** The editors some pane is showing, popups included. */
  visible: readonly EditorId[];
  /**
   * `ui.shotId` as it stands, read only while a Page editor is visible: a shot's picture opens
   * the Asset editor only when it is that shot's. Absent reads as no shot selected.
   */
  shotId?: string;
}

/**
 * What to do with the click. `select` is a node nothing claims (a grouping, or an entity with no
 * document behind it) for which publishing the selection was the whole act.
 */
export type Route =
  { action: 'select' } | { action: 'open'; editor: EditorId; where: OpenWhere; subject: string };

/**
 * Which selection field an editor's subject comes from. A path, a hash and a graph name are not
 * interchangeable (pointing `docPath` at a `.png` would have the wiki editor `doc.read` a binary),
 * so an editor with no entry here has no subject, and the field it does not name is left alone.
 */
export const SUBJECT_OF: Partial<Record<EditorId, 'docPath' | 'assetHash' | 'graphSlug'>> = {
  wiki     : 'docPath',
  skills   : 'docPath',
  documents: 'docPath',
  asset    : 'assetHash',
  gengraph : 'graphSlug',
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
  if (heldByPage(req)) return { action: 'select' };
  const claimants: Claimant[] = [];
  for (const [order, editor] of CLAIMS.entries()) {
    const tier = editor.claims(req.node);
    if (!tier) continue;
    claimants.push({
      editor: editor.id,
      tier,
      visible: req.visible.includes(editor.id),
      order,
    });
  }
  if (claimants.length === 0) return { action: 'select' };

  claimants.sort(better);
  const winner = claimants[0] as Claimant;
  return {
    action : 'open',
    // A visible claimant is focused rather than opened twice, which `open(where='here')` already
    // does. A claimant that is not visible opens in a pane other than the one that asked
    where  : winner.visible ? 'here' : 'elsewhere',
    editor : winner.editor,
    subject: subjectFor(winner.editor, req.node),
  };
}

/** The `view.open` a route opens with, as the action a row's offer lists after its publish. */
export function openOf(route: Route): { id: 'view.open'; props: Record<string, string> } | null {
  if (route.action !== 'open') return null;
  return {
    id   : 'view.open',
    props: { editor: route.editor, where: route.where, subject: route.subject },
  };
}

/**
 * The shot whose picture this row is, for an asset row a shot slot claims or the slot row
 * itself; `undefined` for every other row.
 */
export function shotOfNode(node: DocNode): string | undefined {
  const slot = node.kind === 'asset' ? node.slot : node.kind === 'slot' ? nodeKey(node) : undefined;
  if (slot === undefined || !slot.startsWith('shot:')) return undefined;
  return splitShot(slot.slice('shot:'.length)).shotId;
}

/**
 * Whether a visible Page editor keeps the click from opening anything. Its pane is usually the
 * biggest one, so another shot's picture would replace the page on screen; the click therefore
 * only selects, and the Asset editor opens only on the page's own shot.
 */
function heldByPage(req: RouteRequest): boolean {
  if (!req.visible.includes('page')) return false;
  const shot = shotOfNode(req.node);
  return shot !== undefined && shot !== (req.shotId ?? '');
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
    // A graph row is the graph, so it names itself; every other row names the graph that draws it.
    case 'graphSlug':
      return node.kind === 'graph' ? nodeKey(node) : (node.boundGraph ?? '');
    default:
      return '';
  }
}
