/**
 * What a task has to do with the shell's one selection. Every task surface runs this rule in both
 * directions, so the graph and the list are places to navigate from rather than pictures to look
 * at.
 *
 * The deleted React shell's Floor room kept a `selected` hash of its own, which no other surface
 * could see. Here a task is selected when the shared ids say so, so clicking a shot in the graph,
 * reading its attempts in the inspector and watching it in the runner are the same act.
 */
import type { Task } from '../../src/shared/ipc.js';
import type { TaskNodeView } from '../rules/taskGraph.js';

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
}

/** Shot ids are namespaced `<sceneId>__<raw>`, which is a shot task's only link to a scene. */
const sceneOfShot = (shotId: string): string => shotId.split('__')[0] ?? shotId;

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

/** Whether the selection names a graph node's task. Only a real task is ever selected. */
export function isSelected(view: TaskNodeView, selection: Selection): boolean {
  return view.kind === 'task' && taskIsSelected(view.task, selection);
}
