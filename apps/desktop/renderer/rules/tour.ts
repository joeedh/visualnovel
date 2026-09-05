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
import { EMPTY_DIGEST, UNRESOLVED, type Verdict } from '@vn/commands';
import type { PropValue } from '../../src/shared/ipc.js';
import type { Step, Tour } from '../../src/shared/tours.js';
import {
  UNAVAILABLE,
  resolveAnchor,
  resolveItem,
  resolveNamed,
  resolveSubject,
  type Action,
  type AnchorHome,
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

/**
 * The invocation a step is about. Nothing for a `select`, which names a subject rather than an
 * act, and nothing for a `gesture`, whose invocation is the verdict's answer over live state.
 */
export function actionOf(step: Step): Action | undefined {
  if (step.kind === 'select' || step.kind === 'gesture') return undefined;
  return { id: step.id, props: step.props ?? {} };
}

/**
 * How the overlay should present the step it is on.
 *
 * `ring` is where the author is being pointed. `route` says the app has no control for this and the
 * palette is standing in — the guaranteed floor, since `CommandForm` shows the live `stack.check`
 * verdict above the run button. `open` names a pane the author has to bring up first, and `blocked`
 * carries the app's own refusal rather than one written here, along with the control that refused
 * where there is one, since a greyed control saying why is the whole answer. `pick` points at a row
 * that selects the step's subject, for a step whose control would act on a different one.
 *
 * Named `pick` rather than `select` because a `select` step resolves to `ring`, and one word on
 * both sides of the table would read as the same thing.
 */
export type Guidance =
  | {
      show: 'ring';
      say: string;
      where: Resolution;
      /** Keys to outline more faintly beside the ring — where a gesture could be dropped. */
      also?: readonly string[];
      /** What running the step would invoke, where only the live state can say. */
      awaits?: Action;
    }
  | { show: 'pick'; say: string; where: Resolution; first: string }
  | { show: 'route'; say: string; action: Action }
  | { show: 'open'; say: string; editor: string }
  | { show: 'blocked'; say: string; reason: string; where?: Resolution }
  | { show: 'done' };

/** Said beside the row a `pick` answer rings, under the step's own instruction. */
const PICK_FIRST =
  'Click this first. The button acts on what is selected, and it is on something else.';

type WrongSubject = Extract<Resolution, { state: 'wrong-subject' }>;

/** The values of the held props, which are how the step names its subject. */
function subjectNames(where: WrongSubject): string[] {
  const names: string[] = [];
  for (const name of where.holds) {
    const value = where.needs.props[name];
    if (typeof value === 'string' && value !== '') names.push(value);
  }
  return names;
}

/** Said where the step's subject is named but nothing on screen selects it. */
const missing = (names: readonly string[]): string =>
  `Nothing on screen selects ${names.join(', ')}, which is what this step acts on.`;

/**
 * What to show for the step the tour is on, over a snapshot of what is drawn.
 *
 * A step can name a subject the pane is not showing without anything having gone wrong. The
 * resolver names the selection the step would need, and the tour then asks the author to pick that
 * before pressing a button that would act on the wrong thing.
 */
export function guide(
  map: AnchorMap,
  live: LiveAnchors,
  state: TourState,
  judge?: Judge,
  refused?: Refused,
): Guidance {
  const step = stepOf(state);
  if (!step) return { show: 'done' };

  if (step.kind === 'gesture') return gesture(live, step, judge);

  if (step.kind === 'select') {
    const where = resolveItem(live, step.itemKind, step.key);
    if (where.state === 'disabled') {
      return { show: 'blocked', say: step.say, reason: where.reason, where };
    }
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
    case 'offscreen': {
      // A control that opens a form is drawn enabled, because the button is not what was refused.
      // The refusal belongs to the command behind it, and is the app's own sentence either way.
      const reason = refused?.(where.anchor.key);
      if (reason !== undefined) return { show: 'blocked', say: step.say, reason, where };
      return { show: 'ring', say: step.say, where };
    }
    case 'wrong-subject': {
      const names = subjectNames(where);
      // Nothing here names a subject: the step names props this control does not take, or the
      // conflict is on a flag or a number. There is nothing to select, so the answer is the
      // control's own — which is a refusal where it is greyed.
      if (names.length === 0) {
        if (!where.anchor.enabled) {
          return {
            show  : 'blocked',
            say   : step.say,
            reason: where.anchor.reason ?? UNAVAILABLE,
            where,
          };
        }
        return { show: 'ring', say: step.say, where };
      }
      const subject = resolveSubject(live, where.needs, where.holds, where.anchor.editor);
      if (subject.state === 'absent') {
        return { show: 'blocked', say: step.say, reason: missing(names) };
      }
      return { show: 'pick', say: step.say, where: subject, first: PICK_FIRST };
    }
    case 'disabled':
      return { show: 'blocked', say: step.say, reason: where.reason, where };
    case 'pane-closed':
      return { show: 'open', say: step.say, editor: where.editor };
    default:
      return { show: 'route', say: step.say, action };
  }
}

/**
 * How the app answers what a gesture would do. Undefined where no open surface holds the state
 * that gesture is judged against, which is a different answer from a gesture with nowhere to go.
 */
export type Judge = (
  interaction: string,
  carried: string,
) => { editor: AnchorHome; verdicts: readonly Verdict[] } | undefined;

/**
 * What `stack.check` last said about the anchor with this key, where it said no. Undefined covers
 * both an accepted invocation and one nothing has asked about yet.
 *
 * A lookup rather than a call, because `stack.check` is asynchronous and lives in main while
 * {@link guide} is pure over a snapshot. The caller owns the cache and re-asks; `guide` only reads
 * what came back. See `pathux/tour.ts`.
 */
export type Refused = (key: string) => string | undefined;

type GestureStep = Extract<Step, { kind: 'gesture' }>;

/**
 * A gesture step, judged by the same `targets` the drop itself would call. Nothing is armed and no
 * pointer goes down: the verdicts are read, the thing to pick up is ringed, and whatever would take
 * it is outlined beside it. A refusal is the sentence the command would have given.
 */
function gesture(live: LiveAnchors, step: GestureStep, judge?: Judge): Guidance {
  const judged = judge?.(step.id, step.carried);
  if (!judged) {
    return { show: 'blocked', say: step.say, reason: `Nothing on screen runs ${step.id} yet.` };
  }
  const { editor, verdicts } = judged;
  const unresolved = verdicts.find((verdict) => verdict.target === UNRESOLVED);
  if (unresolved && !unresolved.accept) {
    return { show: 'blocked', say: step.say, reason: unresolved.reason };
  }

  const grab = resolveNamed(live, editor, step.carried);
  if (grab.state === 'absent') {
    return { show: 'blocked', say: step.say, reason: `Nothing on screen names ${step.carried}.` };
  }

  if (step.target === undefined) {
    const taking = verdicts.filter((verdict) => verdict.accept);
    if (taking.length === 0) {
      return { show: 'blocked', say: step.say, reason: 'There is nowhere to drop it.' };
    }
    return { show: 'ring', say: step.say, where: grab, also: keysOf(live, editor, taking) };
  }

  const at = verdicts.find((verdict) => verdict.target === step.target);
  if (!at) {
    return { show: 'blocked', say: step.say, reason: `${step.target} takes no ${step.id}.` };
  }
  if (!at.accept) return { show: 'blocked', say: step.say, reason: at.reason };
  return {
    show  : 'ring',
    say   : step.say,
    where : grab,
    also  : keysOf(live, editor, [at]),
    awaits: { id: at.invoke.id, props: at.invoke.props },
  };
}

/** The anchor each of these targets is drawn as, leaving out the ones nothing on screen names. */
function keysOf(live: LiveAnchors, editor: AnchorHome, verdicts: readonly Verdict[]): string[] {
  const keys: string[] = [];
  for (const verdict of verdicts) {
    const where = resolveNamed(live, editor, verdict.target);
    if ('anchor' in where) keys.push(where.anchor.key);
  }
  return keys;
}

/**
 * Whether what just ran is the step the tour was waiting for. Compared by subsumption rather than
 * equality, because an `input` step names a prop the author has only now typed, and a `command`
 * step may leave a prop for the form to fill in.
 *
 * A gesture names no invocation of its own — which command a drop commits is the verdict's answer,
 * over state only the screen has — so `awaits` is what it is compared against.
 *
 * An `input` step is the one place a value is required rather than ignored. The step exists to
 * have the author supply one, and `art.setNotes` accepts an empty note as a legitimate value, so
 * committing the field blank would otherwise advance the step over a no-op.
 *
 * Anything else means the author went their own way, which is not an error. The caller re-plans.
 */
export function satisfies(step: Step, ran: Action, awaits?: Action): boolean {
  if (step.kind === 'gesture') return awaits !== undefined && subsumed(awaits, ran, '');
  const wanted = actionOf(step);
  if (wanted === undefined) return false;
  if (step.kind === 'input' && !supplied(ran.props[step.supplies])) return false;
  return subsumed(wanted, ran, step.kind === 'input' ? step.supplies : '');
}

/**
 * Whether the author supplied a value. What arrives is the recorded props rather than the real
 * ones, so a bulk prop is a digest: `EMPTY_DIGEST` is what one with no bytes in it records as. A
 * `secret` records as `<secret>` whatever it held, which stays past telling.
 */
function supplied(value: PropValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value !== '' && value !== EMPTY_DIGEST;
  return Array.isArray(value) ? value.length > 0 : true;
}

/** Whether `ran` carries every prop `wanted` names, ignoring the one the author was to type. */
function subsumed(wanted: Action, ran: Action, typed: string): boolean {
  if (wanted.id !== ran.id) return false;
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
