/**
 * The running tour: what is being walked through right now, and what the app says about it.
 *
 * The state lives here rather than in main because only this side knows what is drawn. Main's
 * `tour.*` commands push an effect, this applies it, and the tour advances when `onExec` sees the
 * step's own invocation — from a button, the palette, a hotkey or CDP alike, because a tour follows
 * the command rather than the control.
 *
 * A tour never runs a step. Where a step has no control, the palette is opened on the command with
 * its props filled in and the author presses the run button themselves.
 */
import type { CommandOutcome, PropValue, UiEffect } from '../../src/shared/ipc.js';
import type { Tour } from '../../src/shared/tours.js';
import { readTour } from '../../src/shared/tourcheck.js';
import { tourById } from '../../src/shared/tours.js';
import { ANCHOR_MAP, SWEPT } from '../rules/anchormap.js';
import { guide, satisfies, start, stepOf, type Guidance, type TourState } from '../rules/tour.js';
import type { Action, AnchorHome, LiveAnchors } from '../rules/anchors.js';
import { anchorSnapshot } from './anchors.js';
import { onExec, say } from './bridge.js';
import { verdictsFor } from './gestures.js';
import { follow, ringing, unfollow } from './overlay.js';
import { openPalette } from './palette.js';

type TourEffect = Extract<UiEffect, { type: 'tour' }>;

let running: TourState | undefined;
let unwatch: (() => void) | undefined;
let awaiting: Action | undefined;

/** The tour being walked through, for the overlay to draw and for a test to read. */
export const runningTour = (): TourState | undefined => running;

/** Exposed for CDP, beside `window.__vnAnchors`: which tour is running and which step it is on. */
export function installTour(): void {
  window.__vnTour = () => {
    const state = running;
    if (!state) return null;
    const ring = ringing();
    return {
      tour: state.tour.id,
      at: state.at,
      step: stepOf(state)?.say ?? '',
      ...(ring === undefined ? {} : { ring }),
    };
  };
}

/** Where the panes are, which only the mesh knows. Set once by the shell at startup. */
let openPanes: () => readonly AnchorHome[] = () => [];

export function tourReadsPanes(panes: () => readonly AnchorHome[]): void {
  openPanes = panes;
}

/** Apply what a `tour.*` command asked for. */
export function applyTour(effect: TourEffect): void {
  // Tested against `'start'` rather than against each of the other three: the three share one arm
  // of the union, so excluding them one at a time never narrows away the arm they sit in.
  if (effect.action !== 'start') {
    if (effect.action === 'cancel') return stop();
    if (effect.action === 'explain') return explain();
    if (!running) return say('No tour is running.', true);
    return step({ ...running, at: running.at + 1 });
  }
  const tour = effect.steps ? parse(effect.steps) : tourById(effect.tour);
  // `parse` has already said what was wrong with the JSON, which is more than a name can be.
  if (!tour)
    return effect.steps ? undefined : say(`There is no tour called "${effect.tour}".`, true);
  watch();
  step(start(tour));
}

/**
 * Read a tour written for the moment, as JSON.
 *
 * Only the shape is decided here. Whether a step's command exists is `checkTour`'s answer, asked
 * of `show_me` where an agent-written tour enters, and whether a step would be accepted is
 * `stack.check`'s, asked when the step comes up and over the props the author has by then.
 */
function parse(steps: string): Tour | undefined {
  const read = readTour(steps);
  if (read.ok) return read.tour;
  say(`That tour could not be read — ${read.reason}.`, true);
  return undefined;
}

function watch(): void {
  unwatch?.();
  unwatch = onExec((id, outcome) => ran(id, outcome));
  // The overlay asks rather than being told, because the ring has to survive everything that moves
  // under it between two steps — a pane opening, a scroll, a redraw that rebuilt the control.
  follow(shownNow);
}

function stop(): void {
  unwatch?.();
  unwatch = undefined;
  running = undefined;
  awaiting = undefined;
  unfollow();
}

/**
 * What the step the tour is on means right now, and what running it would invoke. A gesture names
 * no invocation until the verdicts are read, so the answer is kept here for {@link ran}.
 */
function shownNow(): Guidance | undefined {
  if (!running) return undefined;
  const shown = guide(ANCHOR_MAP, live(), running, verdictsFor);
  awaiting = shown.show === 'ring' ? shown.awaits : undefined;
  return shown;
}

/**
 * Move to a step and show it. A finished tour says so and lets go of the exec feed, so nothing is
 * left listening once there is nothing to advance.
 */
function step(next: TourState): void {
  running = next;
  const shown = shownNow() ?? { show: 'done' as const };
  if (shown.show === 'done') {
    say(`Done — ${next.tour.what}`);
    stop();
    return;
  }
  present(shown);
}

/**
 * Say what the step wants, and open the palette where the app draws no control for it.
 *
 * A step the overlay is ringing says nothing here: the caption beside the ring already carries the
 * sentence, and a notification saying it again would be the same words in two places. What is left
 * is the steps with nothing to ring.
 */
function present(shown: Guidance): void {
  if (shown.show === 'done' || shown.show === 'ring') return;
  if (shown.show === 'blocked') {
    if (!shown.where) say(`${shown.say} — but ${shown.reason}`, true);
    return;
  }
  if (shown.show === 'open') return say(`${shown.say} Open the ${shown.editor} pane first.`);
  // The floor. `CommandForm` shows the command's own live verdict above its run button, so the
  // author sees the same refusal a control would have shown, and presses the button themselves.
  openPalette(shown.action.id, shown.action.props);
  say(shown.say);
}

/** What is drawn, filtered to the panes the mesh currently shows. */
function live(): LiveAnchors {
  return anchorSnapshot(openPanes());
}

/**
 * Advance when the step's own invocation runs, whatever ran it. Another command means the author
 * went their own way. That is neither an error nor something to block, so the step is shown again,
 * resolved against wherever they have got to.
 */
function ran(id: string, outcome: CommandOutcome): void {
  const state = running;
  const now = state && stepOf(state);
  if (!state || !now || !outcome.ok) return;
  const props = outcome.record.props as Record<string, PropValue>;
  if (satisfies(now, { id, props }, awaiting)) step({ ...state, at: state.at + 1 });
}

function explain(): void {
  const state = running;
  if (!state) return say('No tour is running.', true);
  const shown = shownNow();
  if (!shown || shown.show === 'done') return say('The tour is finished.');
  if (shown.show !== 'route') return present(shown);
  // A `route` answer comes from the swept map rather than from the screen, so explaining it means
  // saying how old that measurement is.
  const swept = `${SWEPT.at.slice(0, 10)} at ${SWEPT.sha.slice(0, 8)}`;
  present({ ...shown, say: `${shown.say} No pane drew it when the map was swept, ${swept}.` });
}
