/**
 * How the documents editor draws a tree, and what clicking one of its nodes means. Pure: main
 * builds the shape (`src/main/doctree.ts`), and everything the pane decides on top of it — which
 * rows are visible, what a twisty does, which of the four selection fields a node names — is here
 * where it can be tested without a DOM.
 *
 * The same functions serve both modes: a file tree is a different source, not a different kind of
 * tree, so the toggle in the header buys a second fetch and no second flattener.
 */
import { NEW_SKILL_PROMPT } from '../rules/skills.js';
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

/** Flip one node, as a new set. The pane holds the state; this holds the rule. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * What a tree opens on: its roots, and nothing below them. In document mode that is the branch
 * headings, which is a table of contents; expanding further would print every scene, every shot
 * and the whole manifest before the author has asked for any of it.
 *
 * A branch with no children is not opened, which is why an empty Skills branch draws no twisty —
 * the heading is still there, and still right-clickable, which is the whole point of drawing it.
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
 * cost the author their place, which is the same contract `selectionForTask` has. That identity is
 * also what lets the pane spend such a click on the twisty instead, which is how `more` shows what
 * it counted.
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
    // is also all a wiki note, a skill or a bare file has. A skill's path is its `SKILL.md`, so
    // selecting one is selecting that document, and the Skills pane opens on it like any other.
    case 'location':
    case 'wiki':
    case 'skill':
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
 * What the story offers wherever it is right-clicked: from the branch that heads it and from any
 * scene under it. A scene's own acts sit above these, so the scene menu is a superset — the same
 * two commands, in the same words, wherever the pointer was.
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
    // Two acts, and the second is a *form*: `agent.run` is handed a first sentence to edit rather
    // than a turn already sent, because "change this skill" without saying how is a turn the
    // author would only have to interrupt. The skill is named in the sentence, which is how the
    // agent finds it — `discover_skills` already lists them, so nothing else needs to travel.
    case 'skill':
      return [
        {
          label: 'Open in the Skills pane',
          id: 'view.open',
          props: { editor: 'skills', where: 'elsewhere', subject: node.path ?? '' },
        },
        {
          label: 'Ask the agent to change this skill…',
          id: 'agent.run',
          props: { input: `Edit the "${node.label}" skill: ` },
          form: true,
        },
      ];
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
    // A slot has no bytes, so every act on one is about *making* some: hand a file in, adopt one
    // already in the store, or run the pipeline and let it draw. All three take the address as it
    // is written in the tree, and each refuses itself — a `portrait:` slot's two upload entries
    // give `adoptionForSlot`'s own sentence, because the gate owns a look.
    case 'slot':
      return [
        { label: 'Upload a file for this…', id: 'asset.upload', props: { slot: key }, form: true },
        { label: 'Adopt an asset for this…', id: 'asset.adopt', props: { slot: key }, form: true },
        { label: MENU_SEP, id: MENU_SEP },
        { label: 'Run pipeline…', id: 'pipeline.run', form: true },
      ];
    case 'scene':
      return [
        { label: 'Assign line ids', id: 'story.assignLineIds', props: { scene: key } },
        { label: MENU_SEP, id: MENU_SEP },
        ...storyActs(),
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
    // A branch heading is where an author reaches for "another one of these", so each offers what
    // its subtree is made of. `wiki` is the one that is a place rather than a heading — the
    // `wikidir:` nodes are the folders inside it, which a flat `wiki/` never has at all. `assets`
    // offers nothing on purpose: an asset is rendered from a subject, never authored from a name.
    case 'branch':
      switch (key) {
        case 'story':
          return storyActs();
        case 'characters':
          return [newSheet('character', 'New character sheet…')];
        case 'locations':
          return [newSheet('location', 'New location sheet…')];
        case 'wiki':
          return wikiCreate();
        // Two ways to get a skill, and both are forms: the menu can supply neither a name nor a
        // sentence. This is the always-reachable one — the branch is drawn even when empty
        // (`doctree.ts` in main), so the first skill a project ever gets starts here.
        case 'skills':
          return [
            newSheet('skill', 'New skill…'),
            {
              label: 'Ask the agent for a skill…',
              id: 'agent.run',
              props: { input: NEW_SKILL_PROMPT },
              form: true,
            },
          ];
        default:
          return [];
      }
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

/**
 * What double-clicking this node would rename, or `undefined` if it is not renamable. Answering
 * with the props `doc.rename` takes keeps the surface from assembling them: a row that can be
 * renamed is exactly a row this returns something for.
 *
 * A **scene is deliberately not renamable**. Its label is its id, and its id is its filename, the
 * config's `start:` and every `[[goto:]]` pointing at it — one of those is a rename and the rest
 * are a refactor. So are assets, shots and branch headings: none is named by a document at all.
 *
 * **A skill is deliberately left out too, for a different reason.** It has a path and a label, so
 * it looks renamable, but `doc.rename` renames a document by rewriting a `title:` in its
 * front-matter — and a `SKILL.md` has no `title:`. Its label is `name:`, which is a different key,
 * and its id is the directory, which no rewrite of the file could move. Renaming a skill is
 * `edit_skill`, or the Skills pane; a double-click here would silently write a key nobody reads.
 */
export function renameOf(node: DocNode): { path: string; name: string } | undefined {
  if (!node.path) return undefined;
  switch (node.kind) {
    case 'character':
    case 'location':
    case 'wiki':
      return { path: node.path, name: node.label };
    default:
      return undefined;
  }
}

/**
 * What a row says on hover, and no row hovers silently. A path is the useful thing to say where
 * there is one; the rest is what a row with no file says instead.
 *
 * The three facts the tree adds to the node are the arguments, because none is on `DocNode`:
 * `renamable` is `renameOf(node) !== undefined`, `sheetless` is a location known only from a
 * scene heading — its second click writes a sheet rather than renaming one — and `expanded` is
 * the row's own state, which only a counted stand-in has anything to say about.
 */
export function rowTitle(
  node: DocNode,
  opts: { renamable: boolean; sheetless: boolean; expanded: boolean },
): string {
  if (node.path) {
    return opts.renamable ? `${node.path} — double-click the name to rename it` : node.path;
  }
  if (node.note) return node.note;
  if (opts.sheetless) return 'Only a heading names this place — double-click to write its sheet';
  if (node.kind === 'branch' || node.kind === 'assetkind') {
    return 'Show or hide what is filed under this heading';
  }
  if (node.kind === 'more') {
    return opts.expanded
      ? 'Hide the rest of this list again'
      : 'More than the tree draws at once — click to show the rest';
  }
  return `Open this ${node.kind} in its editor`;
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
    case 'skill':
    case 'file':
      return selection.docPath !== '' && selection.docPath === node.path;
    case 'asset':
      return selection.assetHash !== '' && selection.assetHash === key;
    default:
      return false;
  }
}
