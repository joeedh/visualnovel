/**
 * How the documents editor draws a tree, and what clicking one of its nodes means. Pure: main
 * builds the shape (`src/main/doctree.ts`), and everything the pane decides on top of it — which
 * rows are visible, what a twisty does, which of the four selection fields a node names — is here
 * where it can be tested without a DOM.
 *
 * The same functions serve both modes: a file tree is a different source, not a different kind of
 * tree, so the toggle in the header buys a second fetch and no second flattener.
 */
import type { DocNode, EntityLinks } from '../../src/shared/ipc.js';
import type { Selection } from './selection.js';

/** One drawn line: the node, how deep it sits, and what its twisty would do. */
export interface DocRow {
  node: DocNode;
  depth: number;
  /** Has children to show. A node with none draws no twisty rather than an inert one. */
  expandable: boolean;
  expanded: boolean;
}

/** The part of a node id after its `<kind>:` prefix — `greet`, `greet/greet__s1`, `aiko`. */
export function nodeKey(node: DocNode): string {
  return node.id.slice(node.id.indexOf(':') + 1);
}

/** Visible rows, in draw order. A collapsed node contributes one row and hides its subtree. */
export function flattenTree(roots: readonly DocNode[], expanded: ReadonlySet<string>): DocRow[] {
  const rows: DocRow[] = [];
  const walk = (nodes: readonly DocNode[], depth: number): void => {
    for (const node of nodes) {
      const children = node.children ?? [];
      const expandable = children.length > 0;
      const open = expandable && expanded.has(node.id);
      rows.push({ node, depth, expandable, expanded: open });
      if (open) walk(children, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

/** Flip one node, as a new set. The pane holds the state; this holds the rule. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * What a tree opens on: its roots, and nothing below them. In document mode that is the five
 * branches, which is a table of contents; expanding further would print every scene, every shot
 * and the whole manifest before the author has asked for any of it.
 */
export function defaultExpanded(roots: readonly DocNode[]): Set<string> {
  return new Set(roots.filter((node) => node.children?.length).map((node) => node.id));
}

/** `shot:greet/greet__s1` — the scene the node sits under, and the shot itself. */
function splitShot(key: string): { sceneId: string; shotId: string } {
  const cut = key.indexOf('/');
  if (cut < 0) return { sceneId: '', shotId: key };
  return { sceneId: key.slice(0, cut), shotId: key.slice(cut + 1) };
}

/**
 * What clicking a node selects. A grouping and a counted `more` name nothing the shell tracks, so
 * they return the selection **unchanged and identical** — a click meant to open a branch must not
 * cost the author their place, which is the same contract `selectionForTask` has.
 */
export function selectionForNode(node: DocNode, current: Selection): Selection {
  const key = nodeKey(node);
  switch (node.kind) {
    case 'scene': {
      // A shot stays selected only while its own scene is: `<sceneId>__<raw>` is the whole link
      // between the two, and a shot left over from elsewhere would name a scene nothing shows.
      const keep = current.shotId.startsWith(`${key}__`);
      return {
        ...current,
        sceneId: key,
        shotId: keep ? current.shotId : '',
        docPath: node.path ?? current.docPath,
      };
    }
    case 'shot': {
      const { sceneId, shotId } = splitShot(key);
      return { ...current, sceneId: sceneId || current.sceneId, shotId };
    }
    case 'character':
      return { ...current, characterId: key, docPath: node.path ?? current.docPath };
    // A location has no `ui.locationId` to publish, so its sheet is the whole selection — which
    // is also all a wiki note or a bare file has.
    case 'location':
    case 'wiki':
    case 'file':
      return node.path === undefined ? current : { ...current, docPath: node.path };
    // An asset carries no `path` on purpose — it is addressed by hash, which is its key here.
    case 'asset':
      return { ...current, assetHash: key };
    default:
      return current;
  }
}

/**
 * Whose backlinks the panel shows, as a node id `DocTree.backlinks` is keyed by. A character can
 * be named by any surface, so the shared selection answers for one; a location has no selection
 * field of its own, so a click in this tree is the only thing that knows — and while the last
 * click was on one, it wins.
 */
export function backlinkSubject(picked: string, selection: Selection): string {
  if (picked.startsWith('location:')) return picked;
  return selection.characterId === '' ? '' : `character:${selection.characterId}`;
}

/** The node with this id, wherever it sits — how a subject gets the name it is drawn under. */
export function findNode(roots: readonly DocNode[], id: string): DocNode | undefined {
  for (const node of roots) {
    if (node.id === id) return node;
    const found = node.children && findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/** One row of the panel's asset section: a kind, and everything an entity has of it. */
export interface AssetGroup {
  kind: string;
  assets: EntityLinks['assets'];
}

/**
 * An entity's assets, gathered by kind in the order they arrive. A character has a portrait and
 * some model sheets and the difference is what the author is looking for; the manifest's own
 * order is provenance, so it is kept within each kind rather than sorted into something tidier.
 */
export function assetGroups(links: EntityLinks): AssetGroup[] {
  const groups = new Map<string, AssetGroup>();
  for (const asset of links.assets) {
    let group = groups.get(asset.kind);
    if (!group) groups.set(asset.kind, (group = { kind: asset.kind, assets: [] }));
    group.assets.push(asset);
  }
  return [...groups.values()];
}

/** Whether the shared selection names this node — the highlight, for both modes at once. */
export function nodeIsSelected(node: DocNode, selection: Selection): boolean {
  const key = nodeKey(node);
  switch (node.kind) {
    case 'scene':
      return selection.sceneId !== '' && selection.sceneId === key;
    case 'shot':
      return selection.shotId !== '' && selection.shotId === splitShot(key).shotId;
    case 'character':
      return selection.characterId !== '' && selection.characterId === key;
    case 'location':
    case 'wiki':
    case 'file':
      return selection.docPath !== '' && selection.docPath === node.path;
    case 'asset':
      return selection.assetHash !== '' && selection.assetHash === key;
    default:
      return false;
  }
}
