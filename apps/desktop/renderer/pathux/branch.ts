/**
 * The branch canvas's three gestures, as state rather than as markup: what a grab captures, what
 * aiming it at a card or a wire makes of it, and what the author is told during the drag.
 *
 * Position is not semantic on that canvas — there is no `x`/`y` on a `Scene` and the layout is
 * automatic — so a drag selects a verdict rather than moving anything. This is the mid-gesture
 * verdict contract, the same as in `timeline.ts`: `targets` is pure and synchronous, so the gesture
 * is judged once at the grab and every pointer move reads the answer off by target id. The sentence
 * shown mid-drag, the drop that is allowed, and the one `interaction.targets` gives an agent are
 * therefore the same verdict, and the commit is `verdict.invoke` verbatim.
 *
 * This logic lived inside the React `BranchEditor.tsx` and was never tested. It is pure, so it is a
 * module with a `tests/` sibling like every other rule the shell runs.
 */
import {
  CANVAS,
  branchConnect,
  branchSplice,
  branchUnwire,
  type BranchState,
} from '../../src/shared/interactions.js';
import { noticeForVerdict, type Notice } from '../../src/shared/lineedit.js';
import type { Invocation, Verdict } from '@vn/commands';
import type { Point } from '../graph/types.js';

/** Screen-pixel radius of the connect handle, and of the arrowhead a wire can be pulled off by. */
export const GRAB = 15;
/** How far the pointer must travel, in screen pixels, before a press on a card is a splice. */
export const SLOP = 4;

/** Every candidate's verdict, judged once at the grab. Keyed by that candidate's own target id. */
type Verdicts = ReadonlyMap<string, Verdict>;

/** Pointer down on a card and not yet travelled — still a click, and not yet judged as anything. */
export interface Press {
  kind: 'press';
  scene: string;
  /** Where the press started, which is what `SLOP` is measured from. */
  from: Point;
  at: Point;
  verdicts: Verdicts;
  over: null;
  verdict: null;
}

/** A card carried over the wires: `branch.splice`, keyed by edge id. */
export interface Splice {
  kind: 'splice';
  scene: string;
  from: Point;
  at: Point;
  verdicts: Verdicts;
  /** The edge under the pointer. */
  over: string | null;
  verdict: Verdict | null;
}

/** A wire pulled out of a card's handle: `branch.connect`, keyed by scene id. */
export interface Connect {
  kind: 'connect';
  scene: string;
  at: Point;
  verdicts: Verdicts;
  /** The scene card under the pointer. */
  over: string | null;
  verdict: Verdict | null;
}

/** An arrowhead pulled off its target: `branch.unwire`, whose one target is the canvas. */
export interface Unwire {
  kind: 'unwire';
  edge: string;
  at: Point;
  verdicts: Verdicts;
  /** Pulled clear of the arrowhead, far enough to count as deliberate. */
  armed: boolean;
  over: null;
  verdict: Verdict | null;
}

export type Drag = Press | Splice | Connect | Unwire;

/** Where the pointer is and what is under it, as the surface answers those questions. */
export interface Aim {
  /** The pointer in world units. */
  at: Point;
  /** The scene card under the pointer. Never a stub, which is a dangling `goto` and not a scene. */
  node: string | null;
  /** The wire under it. */
  edge: string | null;
  /** Screen-pixel distance from the arrowhead being pulled; only `unwire` reads it. */
  away: number;
  /** The viewport scale, so world-space travel meets a screen-pixel threshold. */
  scale: number;
}

const byTarget = (verdicts: readonly Verdict[]): Verdicts =>
  new Map(verdicts.map((v) => [v.target, v]));

const verdictFor = (verdicts: Verdicts, target: string | null): Verdict | null =>
  target === null ? null : (verdicts.get(target) ?? null);

/**
 * A card pressed. Judged as a splice from the outset even though it may never become one: the
 * promotion happens mid-move and re-judging there would ask `targets` once per pointer move.
 */
export function grabCard(state: BranchState, scene: string, at: Point): Press {
  return {
    kind: 'press',
    scene,
    from: at,
    at,
    verdicts: byTarget(branchSplice.targets(state, scene)),
    over: null,
    verdict: null,
  };
}

/** A card's ⌄ handle pulled out. Every scene is judged up front for whether it takes the wire. */
export function grabHandle(state: BranchState, scene: string, at: Point): Connect {
  return {
    kind: 'connect',
    scene,
    at,
    verdicts: byTarget(branchConnect.targets(state, scene)),
    over: null,
    verdict: null,
  };
}

/** A wire's arrowhead grabbed. One target, so the verdict is settled before the pull begins. */
export function grabArrow(state: BranchState, edge: string, at: Point): Unwire {
  return {
    kind: 'unwire',
    edge,
    at,
    verdicts: byTarget(branchUnwire.targets(state, edge)),
    armed: false,
    over: null,
    verdict: null,
  };
}

/** The drag re-aimed at whatever is now under the pointer. The only entry a pointer move needs. */
export function aim(drag: Drag, to: Aim): Drag {
  switch (drag.kind) {
    case 'press': {
      const travelled = Math.hypot(to.at.x - drag.from.x, to.at.y - drag.from.y) * to.scale;
      if (travelled <= SLOP) return { ...drag, at: to.at };
      // Promoted and re-aimed in the same move, so a large jump lands on the wire it ended over
      // rather than on whatever the next move finds.
      return aim({ ...drag, kind: 'splice', over: null, verdict: null }, to);
    }
    case 'splice':
      return { ...drag, at: to.at, over: to.edge, verdict: verdictFor(drag.verdicts, to.edge) };
    case 'connect':
      return { ...drag, at: to.at, over: to.node, verdict: verdictFor(drag.verdicts, to.node) };
    case 'unwire': {
      // The gesture consists of leaving the arrowhead, so arming turns its one verdict on. Below
      // the threshold nothing is previewed.
      const armed = to.away > GRAB;
      return {
        ...drag,
        at: to.at,
        armed,
        verdict: armed ? verdictFor(drag.verdicts, CANVAS) : null,
      };
    }
  }
}

/** What a release commits: the verdict's own invocation, or nothing at all. */
export function commitOf(drag: Drag): Invocation | null {
  return drag.verdict?.accept ? drag.verdict.invoke : null;
}

/** The verdict's own sentence. A drop that is not a candidate has nothing to say. */
export function noticeOf(drag: Drag | null): Notice | null {
  return drag?.verdict ? noticeForVerdict(drag.verdict) : null;
}

/**
 * The id of the choice a `connect` drop appends, or `null` when it wires a linear continuation
 * instead. A fresh choice is called "New choice" until it is named, so the editor puts the cursor
 * in its label rather than leaving the author to find it.
 *
 * `state` is the graph as it was before the drop, which is what says how many choices the scene
 * already had. The id is `story.graph`'s own `choiceEdgeId` shape, restated rather than imported:
 * that builder is main-side, and the renderer reads edge ids off the graph it is given.
 */
export function newChoiceEdge(state: BranchState, scene: string): string | null {
  const source = state.scenes.get(scene);
  if (!source || (source.choices.length === 0 && source.next === undefined)) return null;
  return `${scene}#choice:${source.choices.length}`;
}
