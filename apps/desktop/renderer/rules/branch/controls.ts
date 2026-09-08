/**
 * What the branch editor's bar and naming row offer. The delete button is anchored only once its
 * `command:check` answers, so its verdict reaches this module as state rather than as a promise.
 */
import type { CommandCheck } from '../../../src/shared/ipc.js';
import { noticeForCheck } from '../../../src/shared/lineedit.js';
import { refuse, type Offer } from '../anchors.js';
import { asInvocation, deleteSceneIntent, newSceneIntent, type NewScene } from './compose.js';

/** What the branch editor reads when it draws its bar and its naming row. */
export interface BranchState {
  /** The selected scene, or the empty string with none. */
  sceneId: string;
  /** Whether the selected scene is one the graph on screen holds. */
  known: boolean;
  /** The new scene being named, while the naming row is open. */
  naming: NewScene | null;
  /** The delete button's verdict, for the scene it was asked about. */
  deleteVerdict?: { scene: string; check: CommandCheck };
}

/** What the delete button does, said before its check answers and again as its tooltip after. */
export const removes = (scene: string): string =>
  `Remove ${scene} and the shots that illustrate it`;

/**
 * Open the naming row. The button rather than the row's own Write it, because this is where
 * writing a scene starts, and both the id and the heading are typed after it.
 */
export function newSceneAction(): Offer {
  return {
    ok      : true,
    id      : 'story.newScene',
    props   : {},
    label   : '+ scene',
    tooltip : 'Name a new scene and add it to the graph, unconnected',
    supplies: ['scene', 'heading'],
  };
}

/**
 * Remove the selected scene, once `deleteScene`'s own check has answered. An accepted check's
 * sentence, how many shots go with the scene, is the tooltip; a refusal is the command's own.
 */
export function deleteSceneAction(scene: string, check: CommandCheck): Offer {
  const step = asInvocation(deleteSceneIntent(scene));
  const control = { id: step.id, label: `delete ${scene}` };
  if (check.state === 'refuse') {
    return { ...refuse(check.message), ...control, tooltip: removes(scene) };
  }
  return {
    ok   : true,
    props: step.props,
    ...control,
    tooltip: noticeForCheck(check)?.text || removes(scene),
  };
}

/** The naming row's Write it, over the draft as it stands when the row is drawn. */
export function writeSceneAction(naming: NewScene): Offer {
  return {
    ok: true,
    ...asInvocation(newSceneIntent(naming)),
    label  : 'Write it',
    tooltip: 'Create the scene file and put it on the graph, connected to nothing',
  };
}

/**
 * Every offer the branch editor draws from this module. The bar's two buttons give way to the
 * naming row's Write it while a scene is being named, and the delete button is listed only once
 * its verdict is in for the scene on screen.
 */
export function controls(state: BranchState): readonly Offer[] {
  if (state.naming) return [writeSceneAction(state.naming)];
  const list: Offer[] = [newSceneAction()];
  const verdict = state.deleteVerdict;
  if (state.sceneId && state.known && verdict?.scene === state.sceneId) {
    list.push(deleteSceneAction(state.sceneId, verdict.check));
  }
  return list;
}
