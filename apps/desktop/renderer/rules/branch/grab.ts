/**
 * Which of the two small drag targets a pointer is on: a card's connect handle, or the
 * arrowhead of a wire that could be pulled off its target.
 *
 * Both straddle a card's boundary — the handle sits on a bottom edge, an arrowhead on the
 * target's top edge — so neither can be resolved by `pick` alone: half of each disc lies where
 * `pick` answers "background" or "that card". This runs first and answers from the discs
 * themselves, which is the only way they are as big as they look in both directions.
 */
import type { EdgeRoute } from '../../graph/edges.js';
import { handleAnchor } from '../../graph/edges.js';
import type { LaidOutNode, Point } from '../../graph/types.js';

export type Grab = { kind: 'connect'; scene: string } | { kind: 'unwire'; edge: string } | null;

const near = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * `radius` is in world units — the caller divides its screen-pixel grab radius by the viewport
 * scale, exactly as hit-testing does. Handles beat arrowheads: a handle is the start of a
 * gesture, and the only case where both discs overlap is a card short enough that its top and
 * bottom are within one radius, where wiring outward is the likelier intent.
 */
export function grabAt(
  nodes: readonly LaidOutNode[],
  routes: readonly EdgeRoute[],
  world: Point,
  radius: number,
  stubs: ReadonlySet<string>,
): Grab {
  let handle: { id: string; distance: number } | null = null;
  for (const node of nodes) {
    if (stubs.has(node.id)) continue;
    const distance = near(world, handleAnchor(node));
    if (distance <= radius && (!handle || distance < handle.distance)) {
      handle = { id: node.id, distance };
    }
  }
  if (handle) return { kind: 'connect', scene: handle.id };

  let head: { id: string; distance: number } | null = null;
  for (const route of routes) {
    const end = route.points[route.points.length - 1];
    if (!end) continue;
    const distance = near(world, end);
    if (distance <= radius && (!head || distance < head.distance)) {
      head = { id: route.id, distance };
    }
  }
  return head ? { kind: 'unwire', edge: head.id } : null;
}
