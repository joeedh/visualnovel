/**
 * A guided tour, as a value: the steps, where the tour has got to, and what the overlay should show
 * for the step it is on.
 *
 * A tour never performs a step. "Do it for me" is an explicit escape that runs the invocation
 * through the same command; the default is that the author clicks, because a tutorial that presses
 * the button teaches nothing.
 *
 * The steps themselves are `shared/tours.ts`, because main's `tour.*` commands name the curated
 * ones. Everything here is pure and node-testable; reaching the screen is `pathux/tour.ts`.
 */
import type { PropValue } from '../../src/shared/ipc.js';
import type { Step, Tour } from '../../src/shared/tours.js';
import {
  resolveAnchor,
  resolveItem,
  type Action,
  type AnchorMap,
  type LiveAnchors,
  type Resolution,
} from './anchors.js';

/** A tour part way through. Immutable: {@link advance} returns the next one. */
export interface TourState {
  tour: Tour;
  at: number;
}

export const start = (tour: Tour): TourState => ({ tour, at: 0 });

export const stepOf = (state: TourState): Step | undefined => state.tour.steps[state.at];

export const finished = (state: TourState): boolean => state.at >= state.tour.steps.length;

export const advance = (state: TourState): TourState => ({ ...state, at: state.at + 1 });

/** The invocation a step is about, or nothing for a `select`, which names a subject rather than an act. */
export function actionOf(step: Step): Action | undefined {
  return step.kind === 'select' ? undefined : { id: step.id, props: step.props ?? {} };
}

/**
 * How the overlay should present the step it is on.
 *
 * `ring` is where the author is being pointed. `route` says the app has no control for this and the
 * palette is standing in — the guaranteed floor, since `CommandForm` shows the live `stack.check`
 * verdict above the run button. `open` names a pane the author has to bring up first, and `blocked`
 * carries the app's own refusal rather than one written here.
 */
export type Guidance =
  | { show: 'ring'; say: string; where: Resolution }
  | { show: 'route'; say: string; action: Action }
  | { show: 'open'; say: string; editor: string }
  | { show: 'blocked'; say: string; reason: string }
  | { show: 'done' };

/**
 * What to show for the step the tour is on, over a snapshot of what is drawn.
 *
 * A step can name a subject the pane is not showing without anything having gone wrong. The
 * resolver names the selection the step would need, and the tour then asks the author to pick that
 * before pressing a button that would act on the wrong thing.
 */
export function guide(map: AnchorMap, live: LiveAnchors, state: TourState): Guidance {
  const step = stepOf(state);
  if (!step) return { show: 'done' };

  if (step.kind === 'select') {
    const where = resolveItem(live, step.itemKind, step.key);
    if (where.state === 'disabled') return { show: 'blocked', say: step.say, reason: where.reason };
    if (where.state === 'absent') {
      return { show: 'blocked', say: step.say, reason: 'Nothing on screen names that yet.' };
    }
    return { show: 'ring', say: step.say, where };
  }

  const action: Action = { id: step.id, props: step.props ?? {} };
  const where = resolveAnchor(map, live, action);
  switch (where.state) {
    case 'ready':
    case 'input':
    case 'offscreen':
    case 'wrong-subject':
      return { show: 'ring', say: step.say, where };
    case 'disabled':
      return { show: 'blocked', say: step.say, reason: where.reason };
    case 'pane-closed':
      return { show: 'open', say: step.say, editor: where.editor };
    default:
      return { show: 'route', say: step.say, action };
  }
}

/**
 * Whether what just ran is the step the tour was waiting for. Compared by subsumption rather than
 * equality, because an `input` step names a prop the author has only now typed, and a `command`
 * step may leave a prop for the form to fill in.
 *
 * Anything else means the author went their own way, which is not an error. The caller re-plans.
 */
export function satisfies(step: Step, ran: Action): boolean {
  const wanted = actionOf(step);
  if (!wanted || wanted.id !== ran.id) return false;
  const typed = step.kind === 'input' ? step.supplies : '';
  for (const [name, value] of Object.entries(wanted.props)) {
    if (name === typed) continue;
    if (!same(ran.props[name], value)) return false;
  }
  return true;
}

function same(a: PropValue | undefined, b: PropValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}
