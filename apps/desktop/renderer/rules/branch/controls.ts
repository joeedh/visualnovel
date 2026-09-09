/**
 * What the branch editor's bar and naming row offer. The delete button is anchored only once its
 * `command:check` answers, so its verdict reaches this module as state rather than as a promise.
 */
import type { CommandCheck, StoryEdge } from '../../../src/shared/ipc.js';
import { noticeForCheck } from '../../../src/shared/lineedit.js';
import { refuse, type Offer } from '../anchors.js';
import { publish, startDrag } from '../effects.js';
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
  /** The scene cards on the canvas, and the shot selected while they are drawn. */
  cards?: { scenes: readonly SceneCard[]; shotId: string };
  /** The edge whose label box is open, while one is. */
  labelling?: LabelledEdge;
}

/** What the label box needs of its edge. */
export type LabelledEdge = Pick<StoryEdge, 'id' | 'from' | 'to' | 'kind' | 'index' | 'label'>;

/** What a card says of its scene. Unreachable is drawn greyed and said in the tooltip. */
export interface SceneCard {
  id: string;
  reachable: boolean;
}

/**
 * What a press on a scene card does. A press that never travels selects the scene, which every
 * other surface follows; a shot left over from another scene is dropped, as `selectionForNode`
 * does for the same click in the document tree. A press that travels is the splice gesture.
 */
export function cardAction(card: SceneCard, shotId: string): Offer {
  const scene = card.id;
  const acts = 'click to select it, right-click to open its script, drag it to lay the graph out';
  return {
    ok: true,
    ...publish({ sceneId: scene, ...(shotId.startsWith(`${scene}__`) ? {} : { shotId: '' }) }),
    on     : `scene/${scene}`,
    label  : scene,
    tooltip: card.reachable
      ? `${scene} — ${acts}`
      : `${scene} — nothing reaches this scene; ${acts}`,
    then   : [startDrag('branch.splice')],
  };
}

/**
 * The box a choice's label is retyped in. The text is what the box supplies; the edge names the
 * scene, the target and the choice's place in the list. A `next` edge carries no label, so its
 * box is refused with the sentence `relabel` gives.
 */
export function labelAction(edge: LabelledEdge): Offer {
  const control = {
    id     : 'story.setChoice',
    on     : `edge/${edge.id}`,
    label  : edge.label ?? '',
    tooltip: 'What this choice reads as in the game. Enter renames it, Escape leaves it.',
  };
  if (edge.kind !== 'choice' || edge.index === undefined) {
    return { ...refuse('Only a choice carries a label.'), ...control };
  }
  return {
    ok: true,
    ...control,
    props   : { scene: edge.from, goto: edge.to, index: edge.index },
    supplies: ['label'],
  };
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
  const cards = state.cards;
  const drawn = cards ? cards.scenes.map((scene) => cardAction(scene, cards.shotId)) : [];
  if (state.labelling) drawn.unshift(labelAction(state.labelling));
  if (state.naming) return [writeSceneAction(state.naming), ...drawn];
  const list: Offer[] = [newSceneAction()];
  const verdict = state.deleteVerdict;
  if (state.sceneId && state.known && verdict?.scene === state.sceneId) {
    list.push(deleteSceneAction(state.sceneId, verdict.check));
  }
  list.push(...drawn);
  return list;
}
