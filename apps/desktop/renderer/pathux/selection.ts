/**
 * What a task has to do with the shell's one selection — the rule every task surface runs in
 * both directions, and the reason the graph and the list are places to navigate from rather
 * than pictures to look at.
 *
 * The React FLOOR kept a `selected` hash of its own, which no other surface could see. Here a
 * task is selected when the shared ids say so, so clicking a shot in the graph, reading its
 * attempts in the inspector and watching it in the runner are the same act.
 */
import type { Task } from '../../src/shared/ipc.js';
import type { TaskNodeView } from '../rooms/floor/taskGraph.js';

export interface Selection {
  sceneId: string;
  shotId: string;
  characterId: string;
}

/** Shot ids are namespaced `<sceneId>__<raw>`, which is a shot task's only link to a scene. */
const sceneOfShot = (shotId: string): string => shotId.split('__')[0] ?? shotId;

/**
 * What clicking a task selects. A shot task names a shot and the scene holding it; a character
 * task names a character. A task naming neither — an export, a validation — returns the
 * selection **unchanged and identical**, so a click on it cannot cost the author their place.
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
 * Whether the shared selection names this task. Several tasks can answer yes to one character —
 * a portrait and its model sheets are all *about* them — and that is the honest answer: the
 * selection is a character, not a task.
 */
export function taskIsSelected(task: Task, selection: Selection): boolean {
  const inputs = task.inputs;
  if ('shotId' in inputs) return selection.shotId === inputs.shotId;
  if ('characterId' in inputs) {
    return selection.characterId !== '' && selection.characterId === inputs.characterId;
  }
  return false;
}

/** The same question of a graph node. Only a real task is ever selected — never a ghost or the barrier. */
export function isSelected(view: TaskNodeView, selection: Selection): boolean {
  return view.kind === 'task' && taskIsSelected(view.task, selection);
}
