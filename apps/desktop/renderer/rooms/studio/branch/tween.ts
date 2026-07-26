/**
 * Interpolating one layout into another.
 *
 * A rewire re-ranks the graph, so a spliced card does not stay where it was dropped — it moves
 * to wherever its new rank puts it. Cutting straight to the new positions reads as the view
 * breaking rather than as the story changing, so the layout is tweened.
 *
 * It has to be the *layout* that moves, not the cards: wires are SVG paths and a CSS
 * transition cannot interpolate path data. Tweening here and re-routing each frame keeps every
 * wire attached to the card it belongs to for the whole of the animation.
 */
import { boundsOf, rectOf, type LaidOutNode } from '../../../graph/types.js';
import type { GraphLayout } from '../../../graph/layout.js';

export const DURATION = 340;

/** Decelerating: the motion is at its fastest when the change is newest. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * `to`'s topology at `t` of the way from `from`'s positions. A node absent from `from` is new
 * — it starts at its destination and is faded in by CSS instead, since it has nowhere to
 * travel from.
 */
export function tweenLayout(from: GraphLayout, to: GraphLayout, t: number): GraphLayout {
  if (t >= 1) return to;
  const eased = easeOutCubic(Math.max(0, t));

  const nodes: LaidOutNode[] = to.nodes.map((node) => {
    const was = from.byId.get(node.id);
    if (!was) return node;
    return { ...node, x: lerp(was.x, node.x, eased), y: lerp(was.y, node.y, eased) };
  });

  return {
    ...to,
    nodes,
    byId: new Map(nodes.map((n) => [n.id, n])),
    bounds: boundsOf(nodes.map(rectOf)),
  };
}
