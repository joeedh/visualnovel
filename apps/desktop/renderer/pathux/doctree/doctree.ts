/**
 * How the documents editor draws a tree, and what clicking one of its nodes means. Pure: main
 * builds the shape (`src/main/doctree/doctree.ts`), and everything the pane decides on top of it — which
 * rows are visible, what a twisty does, which of the four selection fields a node names — is here
 * where it can be tested without a DOM.
 *
 * The same functions serve both modes: a file tree is a different source, not a different kind of
 * tree, so the toggle in the header buys a second fetch and no second flattener.
 *
 * What a click selects, and what a row says on hover, live in `rules/selection.ts` and
 * `rules/documents.ts`, because the row's offer is built from them there.
 */
import { orderEntry, type SceneOrder } from '../../rules/documents.js';
import { NEW_SKILL_PROMPT } from '../../rules/skills.js';
import { nodeKey, splitShot, type Selection } from '../../rules/selection.js';
import type { DocNode, DocNodeKind, EntityLinks } from '../../../src/shared/ipc.js';
import { MENU_SEP, type MenuEntry } from '../chrome/contextmenu.js';

// The selection and title rules moved into `rules/`, where the offers are built from them. They
// are still reached from here by the tree's own callers.
export {
  nodeIsSelected,
  nodeKey,
  publishedBy,
  selectionForNode,
  splitShot,
} from '../../rules/selection.js';
export { renameOf, rowTitle } from '../../rules/documents.js';

/** One drawn line: the node, how deep it sits, and what its twisty would do. */
export interface DocRow {
  node: DocNode;
  depth: number;
  /** Has children to show. A node with none draws no twisty rather than an inert one. */
  expandable: boolean;
  expanded: boolean;
}

/**
 * Visible rows, in draw order. A collapsed node contributes one row and hides its subtree.
 *
 * A `more` node is the one exception, and it is an exception about depth only: what a cap dropped
 * are siblings of the rows above it, not children of the count, so expanding one continues the
 * list at its own indent instead of nesting a copy of the branch inside itself.
 */
export function flattenTree(roots: readonly DocNode[], expanded: ReadonlySet<string>): DocRow[] {
  const rows: DocRow[] = [];
  const walk = (nodes: readonly DocNode[], depth: number): void => {
    for (const node of nodes) {
      const children = node.children ?? [];
      const expandable = children.length > 0;
      const open = expandable && expanded.has(node.id);
      rows.push({ node, depth, expandable, expanded: open });
      if (open) walk(children, node.kind === 'more' ? depth : depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

/** A tree narrowed to a query, and the ids that have to be open for its matches to be on screen. */
export interface FilteredTree {
  roots: DocNode[];
  expanded: Set<string>;
}

/** Drop counted stand-ins, searching what they hold in their place. */
function uncapped(nodes: readonly DocNode[]): DocNode[] {
  return nodes.flatMap((node) => (node.kind === 'more' ? uncapped(node.children ?? []) : [node]));
}

/**
 * The tree narrowed to the nodes whose labels contain `query`, matched without case. An empty query
 * returns the tree unchanged and opens nothing.
 *
 * A node that matches keeps its whole subtree, so a scene found by name is still a scene to drill
 * into, and it is not opened — the author asked for the scene, not for its shots. A node that does
 * not match survives only for the matches beneath it, pruned to them and opened, since a filter
 * whose answers are behind twisties has not filtered anything.
 *
 * A counted `more` node is spliced away wherever the walk reaches one and its children are searched
 * in its place. The cap governs how much of a branch is drawn at rest, and a query is the author
 * asking past it.
 */
export function filterTree(roots: readonly DocNode[], query: string): FilteredTree {
  const needle = query.trim().toLowerCase();
  const expanded = new Set<string>();
  if (needle === '') return { roots: [...roots], expanded };

  const keep = (nodes: readonly DocNode[]): DocNode[] => {
    const out: DocNode[] = [];
    for (const node of uncapped(nodes)) {
      if (node.label.toLowerCase().includes(needle)) {
        out.push(node);
        continue;
      }
      const children = keep(node.children ?? []);
      if (children.length === 0) continue;
      expanded.add(node.id);
      out.push({ ...node, children });
    }
    return out;
  };

  return { roots: keep(roots), expanded };
}

/** Flip one node, returning a new set. The pane holds the expanded state itself. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * A tree opens on its roots, and nothing below them. In document mode the roots are the branch
 * headings, which act as a table of contents. Expanding further would print every scene, every
 * shot and the whole manifest before the author has asked for any of it.
 *
 * A branch with no children is not opened, so an empty Skills branch draws no twisty. The
 * heading is still there, and still right-clickable, which is the whole point of drawing it.
 */
export function defaultExpanded(roots: readonly DocNode[]): Set<string> {
  return new Set(roots.filter((node) => node.children?.length).map((node) => node.id));
}

/**
 * Whose backlinks the panel shows, as a node id `DocTree.backlinks` is keyed by. A character can
 * be named by any surface, so the shared selection answers for one. A location has no selection
 * field of its own, so a click in this tree is the only record of one, and a location clicked last
 * wins.
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
    id   : 'view.open',
    props: { editor: 'wiki', where: 'elsewhere', subject: path },
  };
}

/**
 * `view.open` on the History pane, narrowed to this node's file. Only a node naming one file
 * offers it: a folder's history is a question the tree does not ask, and an entity without a
 * sheet has no file to have a history of.
 */
function showHistory(path: string | undefined): MenuEntry[] {
  if (path === undefined || path === '') return [];
  return [
    {
      label: 'Show history',
      id   : 'view.open',
      props: { editor: 'history', where: 'elsewhere', subject: path },
    },
  ];
}

/** One `doc.create` entry. Spelled once, so the wiki tree and the cast branches agree. */
function newSheet(kind: 'note' | 'character' | 'location' | 'skill', label: string): MenuEntry {
  return { label, id: 'doc.create', props: { kind }, form: true };
}

/**
 * The three things a new page under `wiki/` can be. `doc.create` takes a kind and a name and files
 * it itself, so a nested directory offers exactly what the branch above it does.
 */
function wikiCreate(): MenuEntry[] {
  return [
    newSheet('note', 'New wiki page…'),
    newSheet('character', 'New character sheet…'),
    newSheet('location', 'New location sheet…'),
  ];
}

/**
 * Offers to wire a graph that draws `slot`, where the row names one. An asset row names a slot only
 * when a slot claims that picture, so a concept, an upload or a base asset offers nothing here. The
 * command decides whether the address can have a graph, since a slot another graph already draws is
 * refused by name.
 */
function graphAct(slot: string | undefined): MenuEntry[] {
  if (slot === undefined || slot === '') return [];
  return [{ label: 'Create a graph for this slot', id: 'gengraph.createForSlot', props: { slot } }];
}

/**
 * `app.copy` on this row's id, worded for the kind of thing it names. Every row addressed by an id
 * an author might type somewhere else — a scene into the agent, a shot into a command, a hash into
 * a prompt — offers one, because the id is on screen but not selectable.
 */
function copyId(what: string, id: string): MenuEntry {
  return { label: `Copy ${what} id`, id: 'app.copy', props: { text: id, what: `${what} id` } };
}

/**
 * What a row's picture offers: approval, or taking one back. Only ever one of the two, since the
 * other would be refused, and a menu that lists both makes the author read a refusal to find out
 * which. `gate.approve` and `art.promote` stay on the approving side, where each declares its own
 * refusal for the kinds it is not for.
 */
function approvalActs(hash: string, approved: boolean): MenuEntry[] {
  if (approved)
    return [{ label: 'Un-approve', id: 'asset.unapprove', props: { hash }, form: true }];
  return [
    { label: 'Accept', id: 'asset.accept', props: { hash } },
    { label: 'Approve as a portrait…', id: 'gate.approve', props: { hash }, form: true },
    { label: 'Promote to a plate…', id: 'art.promote', props: { hash }, form: true },
  ];
}

/**
 * These entries appear wherever the story is right-clicked, from the branch that heads it and
 * from any scene under it. A scene's own acts sit above these, so the scene menu ends up a
 * superset: the same two commands, in the same words, wherever the pointer was.
 */
function storyActs(): MenuEntry[] {
  return [
    { label: 'New scene…', id: 'story.newScene', form: true },
    { label: 'Export Fountain', id: 'story.screenplay' },
  ];
}

/**
 * What right-clicking a node offers. Every entry is a command, and the ones needing an argument a
 * menu cannot supply — a sentence to draw from, a name, a variant, a line of prose — open the
 * palette on their own form instead; so does every `confirm: true` one, because the palette is
 * where a command says what it is about to do.
 *
 * Kinds with nothing to offer answer with an empty list, and are named here rather than falling
 * through silently, so a new node kind shows up as a missing case.
 *
 * `order` is how the pane is sorting the Story branch, which its heading's menu offers to switch.
 */
export function menuFor(node: DocNode, order: SceneOrder = 'stored'): MenuEntry[] {
  const key = nodeKey(node);
  switch (node.kind) {
    case 'location':
      return [
        // A reference shot of a place is a concept bound to that place: `art.generate` with the
        // subject already answered, so only the sentence is left to fill in
        {
          label: 'New reference shot…',
          id   : 'art.generate',
          props: { subject: `location:${key}`, open: true },
          form : true,
        },
        {
          label: 'Art notes…',
          id   : 'art.setNotes',
          props: { target: `location:${key}` },
          form : true,
        },
        copyId('location', key),
        ...(node.path ? [openSheet(node.path)] : []),
        ...showHistory(node.path),
      ];
    case 'character':
      return [
        {
          label: 'New concept image…',
          id   : 'art.generate',
          props: { subject: `character:${key}`, open: true },
          form : true,
        },
        {
          label: 'Art notes…',
          id   : 'art.setNotes',
          props: { target: `character:${key}` },
          form : true,
        },
        copyId('character', key),
        ...(node.path ? [openSheet(node.path)] : []),
        ...showHistory(node.path),
      ];
    case 'wikidir':
      return wikiCreate();
    // Running and deleting open as forms, so the palette can quote the estimate and take a
    // confirmation before anything is spent or lost
    case 'graph':
      return [
        { label: 'What would a run cost?', id: 'gengraph.estimate', props: { slug: key } },
        { label: 'Run this graph…', id: 'gengraph.run', props: { slug: key }, form: true },
        { label: MENU_SEP, id: MENU_SEP },
        copyId('graph', key),
        { label: 'Delete this graph…', id: 'gengraph.delete', props: { slug: key }, form: true },
      ];
    // The second entry is a form: `agent.run` is handed a first sentence to edit rather than a turn
    // already sent. The skill is named in that sentence, which is how the agent finds it —
    // `discover_skills` already lists them, so nothing else needs to travel
    case 'skill':
      return [
        {
          label: 'Open in the Skills pane',
          id   : 'view.open',
          props: { editor: 'skills', where: 'elsewhere', subject: node.path ?? '' },
        },
        {
          label: 'Ask the agent to change this skill…',
          id   : 'agent.run',
          props: { input: `Edit the "${node.label}" skill: ` },
          form : true,
        },
        copyId('skill', key),
      ];
    // There is no 'reject' among the approving acts, because rejecting a candidate is approving
    // another
    case 'asset':
      return [
        { label: 'Regenerate…', id: 'asset.regenerate', props: { hash: key }, form: true },
        ...approvalActs(key, node.approved === true),
        ...graphAct(node.slot),
        { label: MENU_SEP, id: MENU_SEP },
        // Below the separator with the other acts that leave the project alone: this one copies
        // the bytes out and changes nothing in the workspace
        { label: 'Download image…', id: 'asset.export', props: { hash: key } },
        copyId('asset', key),
        {
          label: 'Open in the Asset editor',
          id   : 'view.open',
          props: { editor: 'asset', where: 'elsewhere', subject: key },
        },
      ];
    // A slot has no bytes, so every act on one is about making some: hand a file in, adopt one from
    // the store, wire a graph that draws it, or run the pipeline. The first three take the address
    // the tree writes, and a `portrait:` slot's upload entries give `adoptionForSlot`'s own refusal
    case 'slot':
      return [
        { label: 'Upload a file for this…', id: 'asset.upload', props: { slot: key }, form: true },
        { label: 'Adopt an asset for this…', id: 'asset.adopt', props: { slot: key }, form: true },
        ...graphAct(key),
        { label: MENU_SEP, id: MENU_SEP },
        copyId('slot', key),
        { label: 'Run pipeline…', id: 'pipeline.run', form: true },
      ];
    // The agent entry is a form for the same reason the skill one is: `agent.run` is handed a
    // first sentence to edit rather than a turn already sent, so the author says what to change
    // before anything is spent
    case 'scene':
      return [
        { label: 'Assign line ids', id: 'story.assignLineIds', props: { scene: key } },
        {
          label: 'Edit in the agent…',
          id   : 'agent.run',
          props: { input: `edit ${key} ` },
          form : true,
        },
        { label: MENU_SEP, id: MENU_SEP },
        copyId('scene', key),
        ...showHistory(node.path),
        { label: MENU_SEP, id: MENU_SEP },
        ...storyActs(),
      ];
    case 'shot': {
      const { sceneId, shotId } = splitShot(key);
      return [
        {
          label: 'Set coverage…',
          id   : 'story.setCoverage',
          props: { scene: sceneId, shot: shotId },
          form : true,
        },
        {
          label: 'Set outfit…',
          id   : 'story.setOutfit',
          props: { scene: sceneId, shot: shotId },
          form : true,
        },
        // A member of a staging-sheet group offers the group's graph, which draws every member;
        // the command refuses by name once one already does
        ...(node.sheet === undefined
          ? []
          : [
              {
                label: `Scaffold a sheet graph for group ${node.sheet}`,
                id   : 'gengraph.scaffoldSheet',
                props: { scene: sceneId, sheet: node.sheet },
              },
            ]),
        // The frame the storyboard recorded, where there is one, so the picture a shot stands for
        // is approvable from the row that names it
        ...(node.hash
          ? [{ label: MENU_SEP, id: MENU_SEP }, ...approvalActs(node.hash, node.approved === true)]
          : []),
        { label: MENU_SEP, id: MENU_SEP },
        copyId('shot', shotId),
      ];
    }
    // A branch heading is where an author reaches for "another one of these", so each offers what
    // its subtree is made of. `wiki` is a place rather than a heading, and the `wikidir:` nodes are
    // its folders. `assets` offers nothing: an asset is rendered, never authored from a name
    case 'branch':
      switch (key) {
        case 'story':
          return [...storyActs(), { label: MENU_SEP, id: MENU_SEP }, orderEntry(order)];
        case 'characters':
          return [newSheet('character', 'New character sheet…')];
        case 'locations':
          return [newSheet('location', 'New location sheet…')];
        case 'wiki':
          return wikiCreate();
        case 'graphs':
          return [{ label: 'New generation graph…', id: 'gengraph.create', form: true }];
        // Two ways to get a skill, and both are forms: the menu can supply neither a name nor a
        // sentence. This is the always-reachable one — the branch is drawn even when empty
        // (`doctree.ts` in main), so the first skill a project ever gets starts here.
        case 'skills':
          return [
            newSheet('skill', 'New skill…'),
            {
              label: 'Ask the agent for a skill…',
              id   : 'agent.run',
              props: { input: NEW_SKILL_PROMPT },
              form : true,
            },
          ];
        default:
          return [];
      }
    // A page or a file names no subject a write takes: nothing binds to a wiki note (see
    // `assetstrip.ts`) and `doc.write` needs the text. Its history is the one thing left to ask
    case 'wiki':
    case 'file':
      return showHistory(node.path);
    case 'assetkind':
    case 'dir':
    case 'more':
      return [];
  }
}

/**
 * One node of each kind the tree draws, and one of each branch heading, so the coverage below is
 * total rather than however much of a project happens to be on screen. Every node carries a path
 * and a hash, since several kinds offer more entries once they have one, and the shot is in a
 * sheet group for the same reason. Exported for the derived model's driver, which runs `menuFor`
 * over the same nodes.
 */
export const MENU_NODES: readonly DocNode[] = [
  ...(
    [
      'scene',
      'shot',
      'character',
      'location',
      'wikidir',
      'wiki',
      'assetkind',
      'asset',
      'slot',
      'skill',
      'graph',
      'dir',
      'file',
      'more',
    ] as const satisfies readonly Exclude<DocNodeKind, 'branch'>[]
  ).map((kind) => ({
    id      : `${kind}:sample${kind === 'shot' ? '/shot1' : ''}`,
    kind    : kind as DocNodeKind,
    label   : kind,
    path    : `wiki/${kind}.md`,
    hash    : 'a1b2c3d4',
    slot    : 'plate:sample/night',
    approved: false,
    ...(kind === 'shot' ? { sheet: 'g1' } : {}),
  })),
  ...['story', 'characters', 'locations', 'wiki', 'graphs', 'skills', 'assets'].map((key) => ({
    id   : `branch:${key}`,
    kind : 'branch' as DocNodeKind,
    label: key,
  })),
];
