/**
 * What a gesture means, as a command invocation — or why it is refused.
 *
 * Every decision here delegates to `shared/branchops`, the same module the `story.*` commands
 * run in main. So the sentence shown while a card hovers over an edge it cannot be spliced
 * into is produced by the function that would have refused the drop, not by a second reading
 * of the rules. The only thing this file adds is which command carries the decision.
 */
import { removeChoice, setChoice, setNext, spliceScene } from '../../../../src/shared/branchops';
import { edgeTarget } from './graph.js';
import type { PropValue, StoryEdge } from '../../../../src/shared/ipc';
import type { BranchOp, SceneMap } from '../../../../src/shared/branchops';

/** A new choice has to be called something before the author has named it. */
export const NEW_CHOICE = 'New choice';

export interface Intent {
  id: string;
  props: Record<string, PropValue>;
  /** What the command will report — used as the drop preview, so the two read the same. */
  note: string;
}

export type Decision = { ok: true; intent: Intent } | { ok: false; reason: string };

const decide = (op: BranchOp, id: string, props: Record<string, PropValue>): Decision =>
  op.ok ? { ok: true, intent: { id, props, note: op.message } } : { ok: false, reason: op.error };

/**
 * Wire `from` to `to`. A scene with nothing leaving it continues linearly; anything else gains
 * a choice — including a scene that already has a bare `next`, whose fallthrough the runner
 * will then stop following. That is not refused: the now-inert edge is drawn struck through,
 * which says it better than a modal would.
 */
export function connect(scenes: SceneMap, from: string, to: string): Decision {
  const scene = scenes.get(from);
  if (scene && scene.choices.length === 0 && scene.next === undefined) {
    return decide(setNext(scenes, { scene: from, goto: to }), 'story.setNext', {
      scene: from,
      goto: to,
    });
  }
  return decide(
    setChoice(scenes, { scene: from, goto: to, label: NEW_CHOICE }),
    'story.setChoice',
    { scene: from, goto: to, label: NEW_CHOICE },
  );
}

/** Drop scene `scene` onto `edge`: `A→B` becomes `A→scene→B`. */
export function splice(scenes: SceneMap, scene: string, edge: StoryEdge): Decision {
  const target = edgeTarget(edge);
  return decide(spliceScene(scenes, { scene, ...target }), 'story.spliceScene', {
    scene,
    from: target.from,
    ...(target.edge !== undefined ? { edge: target.edge } : {}),
  });
}

/** Pull an edge's endpoint off its target: remove the choice, or clear the continuation. */
export function unwire(scenes: SceneMap, edge: StoryEdge): Decision {
  if (edge.kind === 'next') {
    return decide(setNext(scenes, { scene: edge.from }), 'story.setNext', {
      scene: edge.from,
      goto: '',
    });
  }
  const index = edge.index ?? 0;
  return decide(removeChoice(scenes, { scene: edge.from, index }), 'story.removeChoice', {
    scene: edge.from,
    index,
  });
}

/** Retype a choice's decision text. The edge keeps its index, so it stays the same choice. */
export function relabel(scenes: SceneMap, edge: StoryEdge, label: string): Decision {
  if (edge.kind !== 'choice' || edge.index === undefined) {
    return { ok: false, reason: 'Only a choice carries a label.' };
  }
  const props = { scene: edge.from, goto: edge.to, label, index: edge.index };
  return decide(setChoice(scenes, props), 'story.setChoice', props);
}
