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
import { MENU_SEP, type MenuEntry } from './contextmenu.js';
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

/** One headed row of an asset strip: what the group is called, and what is in it. */
export interface AssetGroup {
  title: string;
  assets: EntityLinks['assets'];
}

/** Group by a key each asset answers for, in the order the keys first appear. */
function gather(
  assets: EntityLinks['assets'],
  keyOf: (asset: EntityLinks['assets'][number]) => string,
): AssetGroup[] {
  const groups = new Map<string, AssetGroup>();
  for (const asset of assets) {
    const key = keyOf(asset);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { title: key, assets: [] }));
    group.assets.push(asset);
  }
  return [...groups.values()];
}

/**
 * A subject's assets, gathered by kind in the order they arrive. A character has a portrait and
 * some model sheets and the difference is what the author is looking for; the manifest's own
 * order is provenance, so it is kept within each kind rather than sorted into something tidier.
 */
export function assetGroups(links: EntityLinks): AssetGroup[] {
  return gather(links.assets, (a) => a.kind.replace(/_/g, ' ').toUpperCase());
}

/**
 * A scene's assets, gathered by the shot each one frames. The other axis on the same list: for a
 * scene every frame is a `shot_image`, so grouping by kind would draw one heading over everything,
 * whereas which shot a frame belongs to is the question an author writing the scene is asking.
 * Anything the scene binds without naming a shot goes under the scene itself.
 */
export function shotGroups(links: EntityLinks, sceneId: string): AssetGroup[] {
  return gather(links.assets, (a) => a.shotId ?? sceneId);
}

/** `view.open` on this node's sheet, put anywhere but the pane the menu was raised in. */
function openSheet(path: string): MenuEntry {
  return {
    label: 'Open sheet elsewhere',
    id: 'view.open',
    props: { editor: 'wiki', where: 'elsewhere', subject: path },
  };
}

/**
 * The three things a new page under `wiki/` can be. `doc.create` takes a kind and a name and files
 * it itself, so a nested directory offers exactly what the branch above it does.
 */
function wikiCreate(): MenuEntry[] {
  return [
    { label: 'New wiki page…', id: 'doc.create', props: { kind: 'note' }, form: true },
    { label: 'New character sheet…', id: 'doc.create', props: { kind: 'character' }, form: true },
    { label: 'New location sheet…', id: 'doc.create', props: { kind: 'location' }, form: true },
  ];
}

/**
 * What right-clicking a node offers. Every entry is a command, and the ones needing an argument a
 * menu cannot supply — a sentence to draw from, a name, a variant, a line of prose — open the
 * palette on their own form instead; so does every `confirm: true` one, because the palette is
 * where a command says what it is about to do.
 *
 * Kinds with nothing to offer answer with an empty list, and are named here rather than falling
 * through silently: a new node kind should be a visible hole, not nothing.
 */
export function menuFor(node: DocNode): MenuEntry[] {
  const key = nodeKey(node);
  switch (node.kind) {
    case 'location':
      return [
        // The todo's own words. A reference shot of a place is a concept bound to that place —
        // `art.generate` with the subject already answered, so the sentence is all that is left.
        {
          label: 'New reference shot…',
          id: 'art.generate',
          props: { subject: `location:${key}`, open: true },
          form: true,
        },
        {
          label: 'Art notes…',
          id: 'art.setNotes',
          props: { target: `location:${key}` },
          form: true,
        },
        ...(node.path ? [openSheet(node.path)] : []),
      ];
    case 'character':
      return [
        {
          label: 'New concept image…',
          id: 'art.generate',
          props: { subject: `character:${key}`, open: true },
          form: true,
        },
        {
          label: 'Art notes…',
          id: 'art.setNotes',
          props: { target: `character:${key}` },
          form: true,
        },
        ...(node.path ? [openSheet(node.path)] : []),
      ];
    case 'wikidir':
      return wikiCreate();
    // All four acts are offered and each refuses itself: `asset.accept` names `gate.approve` for a
    // portrait and `art.promote` for a concept, and those two refuse everything else. The commands
    // already know which one applies, and their sentences beat a menu's guess. There is no
    // 'reject' — rejecting a candidate is approving a different one, and inventing the command
    // here would be designing the gate through a menu.
    case 'asset':
      return [
        { label: 'Regenerate…', id: 'asset.regenerate', props: { hash: key }, form: true },
        { label: 'Accept', id: 'asset.accept', props: { hash: key } },
        { label: 'Approve as a portrait…', id: 'gate.approve', props: { hash: key }, form: true },
        { label: 'Promote to a plate…', id: 'art.promote', props: { hash: key }, form: true },
        { label: MENU_SEP, id: MENU_SEP },
        {
          label: 'Open in the Asset editor',
          id: 'view.open',
          props: { editor: 'asset', where: 'elsewhere', subject: key },
        },
      ];
    case 'scene':
      return [
        { label: 'Assign line ids', id: 'story.assignLineIds', props: { scene: key } },
        { label: 'Write the screenplay', id: 'story.screenplay' },
      ];
    case 'shot': {
      const { sceneId, shotId } = splitShot(key);
      return [
        {
          label: 'Set coverage…',
          id: 'story.setCoverage',
          props: { scene: sceneId, shot: shotId },
          form: true,
        },
        {
          label: 'Set outfit…',
          id: 'story.setOutfit',
          props: { scene: sceneId, shot: shotId },
          form: true,
        },
      ];
    }
    // The one branch that is a place rather than a heading: the todo asks for a new page from the
    // top of the wiki tree, and that top is `branch:wiki` — the `wikidir:` nodes are the folders
    // inside it, which a project with a flat `wiki/` never has at all.
    case 'branch':
      return key === 'wiki' ? wikiCreate() : [];
    // A grouping, a page, a bare file and a counted stand-in: none names a subject a command takes.
    // A wiki note is the interesting one — nothing binds to it (see `assetstrip.ts`) and `doc.write`
    // needs the text, so the only act it has is the one a plain click already performs.
    case 'assetkind':
    case 'wiki':
    case 'dir':
    case 'file':
    case 'more':
      return [];
  }
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
