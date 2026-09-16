/**
 * What a document-tree node or a task has to do with the shell's one selection. Every surface
 * that publishes a selection runs these rules in both directions, so the tree, the graph and the
 * list are places to navigate from rather than pictures to look at.
 *
 * The deleted React shell's Floor room kept a `selected` hash of its own, which no other surface
 * could see. Here a task is selected when the shared ids say so, so clicking a shot in the graph,
 * reading its attempts in the inspector and watching it in the runner are the same act.
 *
 * In `rules/` rather than under `pathux/` because the rule modules build `ui.publish` offers from
 * these answers, and a rule module imports nothing that needs a DOM.
 */
import type { DocNode, Task } from '../../src/shared/ipc.js';

/** The part of a node id after its `<kind>:` prefix — `greet`, `greet/greet__s1`, `aiko`. */
export function nodeKey(node: DocNode): string {
  return node.id.slice(node.id.indexOf(':') + 1);
}

/** `shot:greet/greet__s1` — the scene the node sits under, and the shot itself. */
export function splitShot(key: string): { sceneId: string; shotId: string } {
  const cut = key.indexOf('/');
  if (cut < 0) return { sceneId: '', shotId: key };
  return { sceneId: key.slice(0, cut), shotId: key.slice(cut + 1) };
}

export interface Selection {
  sceneId: string;
  shotId: string;
  characterId: string;
  /** The authored document. No task names one, so every rule here carries it through untouched. */
  docPath: string;
  /**
   * The generated asset, by hash. A task produces one but does not name one (an asset's hash is
   * its bytes, not its recipe), so like `docPath` it is carried through untouched here.
   */
  assetHash: string;
  /**
   * The generation graph, by slug. No task names one either: a slot names a graph and a task
   * names a slot, so the document tree resolves it and every rule here carries it through.
   */
  graphSlug: string;
}

/**
 * Which `ui.*` fields clicking this task would change, and to what. An anchor carries this so a
 * tour can say which card puts a task on screen without running the click to find out.
 */
export function taskPublishes(task: Task, current: Selection): Record<string, string> {
  const next = selectionForTask(task, current);
  const changed: Record<string, string> = { taskHash: task.hash };
  for (const field of Object.keys(next) as (keyof Selection)[]) {
    if (next[field] !== current[field]) changed[field] = next[field];
  }
  return changed;
}

/** Shot ids are namespaced `<sceneId>__<raw>`, which is a shot task's only link to a scene. */
export const sceneOfShot = (shotId: string): string => shotId.split('__')[0] ?? shotId;

/**
 * What clicking a task selects. A shot task names a shot and the scene holding it; a character
 * task names a character. A task naming neither (an export, a validation) returns the selection
 * unchanged and identical, so a click on it cannot cost the author their place.
 */
export function selectionForTask(task: Task, current: Selection): Selection {
  const inputs = task.inputs;
  if ('shotId' in inputs) {
    return { ...current, shotId: inputs.shotId, sceneId: sceneOfShot(inputs.shotId) };
  }
  if ('characterId' in inputs) return { ...current, characterId: inputs.characterId };
  return current;
}

/**
 * Whether the shared selection names this task. Several tasks can answer yes for one character,
 * because a portrait and its model sheets are all about that character; the selection is a
 * character rather than a task.
 */
export function taskIsSelected(task: Task, selection: Selection): boolean {
  const inputs = task.inputs;
  if ('shotId' in inputs) return selection.shotId === inputs.shotId;
  if ('characterId' in inputs) {
    return selection.characterId !== '' && selection.characterId === inputs.characterId;
  }
  return false;
}

/**
 * What clicking a node selects. A grouping and a counted `more` name nothing the shell tracks, so
 * they return the same selection object unchanged — a click meant to open a branch must not cost
 * the author their place, which is the same contract `selectionForTask` has. That identity is also
 * what lets the pane spend such a click on the twisty instead, which is how `more` shows what it
 * counted.
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
        shotId : keep ? current.shotId : '',
        docPath: node.path ?? current.docPath,
      };
    }
    // A shot a graph draws selects that graph too, for the reason the asset case below gives: the
    // shot's own editors still claim the click, and an open Gen Graph pane follows it.
    case 'shot': {
      const { sceneId, shotId } = splitShot(key);
      const picked = { ...current, sceneId: sceneId || current.sceneId, shotId };
      return node.boundGraph === undefined ? picked : { ...picked, graphSlug: node.boundGraph };
    }
    // A graph is named by its slug rather than by its file, so selecting one leaves `docPath`
    // alone: `doc.*` refuses `work/graphs/**`, and a graph opened as text would go past every
    // `gengraph.*` check.
    case 'graph':
      return { ...current, graphSlug: key };
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
    // An asset carries no `path` on purpose — it is addressed by hash, which is its key here. A
    // picture drawn by a graph selects that graph as well, so an open Gen Graph pane follows the
    // click without taking it: the Asset editor still claims the picture, and routing is unchanged.
    case 'asset': {
      const picked = { ...current, assetHash: key };
      return node.boundGraph === undefined ? picked : { ...picked, graphSlug: node.boundGraph };
    }
    // A slot a graph draws selects that graph, which is what the Gen Graph pane opens on. A slot
    // no graph draws names nothing the shell tracks, so it costs the author nothing to click.
    case 'slot':
      return node.boundGraph === undefined ? current : { ...current, graphSlug: node.boundGraph };
    default:
      return current;
  }
}

/**
 * Which `ui.*` fields clicking this row would change, and to what. An anchor carries this so a tour
 * can say which row puts a subject on screen without running the click to find out.
 */
export function publishedBy(node: DocNode, current: Selection): Record<string, string> {
  const next = selectionForNode(node, current);
  const changed: Record<string, string> = {};
  for (const field of Object.keys(next) as (keyof Selection)[]) {
    if (next[field] !== current[field]) changed[field] = next[field];
  }
  return changed;
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
    case 'graph':
      return selection.graphSlug !== '' && selection.graphSlug === key;
    default:
      return false;
  }
}
