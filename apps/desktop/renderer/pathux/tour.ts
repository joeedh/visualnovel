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
import type { CatalogProp, CommandOutcome, PropValue, UiEffect } from '../../src/shared/ipc.js';
import type { Tour } from '../../src/shared/tours.js';
import { readTour } from '../../src/shared/tourcheck.js';
import { tourById } from '../../src/shared/tours.js';
import { api } from '../api.js';
import { ANCHOR_MAP, SWEPT } from '../rules/anchormap.js';
import { askedAs, checkFor } from '../rules/precheck.js';
import { guide, satisfies, start, stepOf, type Guidance, type TourState } from '../rules/tour.js';
import type { Action, Anchor, AnchorHome, LiveAnchors } from '../rules/anchors.js';
import { anchorSnapshot } from './anchors.js';
import { exec, onExec, onWrote, say } from './bridge.js';
import { verdictsFor } from './gestures.js';
import { follow, ringing, unfollow, type Showing } from './overlay.js';
import { closePalette, openPalette } from './palette.js';

type TourEffect = Extract<UiEffect, { type: 'tour' }>;

let running: TourState | undefined;
let unwatch: (() => void) | undefined;
let awaiting: Action | undefined;
/** Whether the palette is up because a step routed to it, so the tour can take it back down. */
let routed = false;
/**
 * What `stack.check` said about a ringed anchor, keyed by anchor key. `as` is the invocation that
 * answer was about, so a redraw that changed the anchor's props asks again and one that did not
 * costs nothing.
 */
const asked = new Map<string, { as: string; reason?: string }>();
/** Each command's props, for the blanks {@link checkFor} fills in. Fetched once per tour. */
let specs: Map<string, readonly CatalogProp[]> | undefined;

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
  const feeds = [
    onExec((id, outcome) => ran(id, outcome)),
    // A refusal is about the project, so it stops being true as soon as anything is written.
    onWrote(() => asked.clear()),
  ];
  unwatch = () => feeds.forEach((drop) => drop());
  void api.invoke('command:catalog').then((catalog) => {
    specs = new Map(catalog.commands.map((entry) => [entry.id, entry.props]));
  });
  // The overlay asks rather than being told, because the ring has to survive everything that moves
  // under it between two steps — a pane opening, a scroll, a redraw that rebuilt the control.
  follow(showingNow, () => void exec('tour.cancel'));
}

function stop(): void {
  unwatch?.();
  unwatch = undefined;
  running = undefined;
  awaiting = undefined;
  routed = false;
  asked.clear();
  unfollow();
}

/**
 * Ask whether the anchor a step points at would run. The answer is not waited for: it lands in
 * {@link asked} and the overlay's next re-resolve reads it, a beat later.
 */
function askAbout(anchor: Anchor): void {
  const props = specs?.get(anchor.id ?? '');
  if (!props) return;
  const action = checkFor(anchor, props);
  if (!action) return;
  const as = askedAs(action);
  if (asked.get(anchor.key)?.as === as) return;
  asked.set(anchor.key, { as });
  void api.invoke('command:check', { id: action.id, props: action.props }).then((verdict) => {
    if (asked.get(anchor.key)?.as !== as) return;
    const refused = verdict.state === 'refuse';
    asked.set(anchor.key, { as, ...(refused ? { reason: verdict.message } : {}) });
  });
}

/**
 * What the step the tour is on means right now, and what running it would invoke. A gesture names
 * no invocation until the verdicts are read, so the answer is kept here for {@link ran}.
 */
function shownNow(): Guidance | undefined {
  if (!running) return undefined;
  const shown = guide(ANCHOR_MAP, live(), running, verdictsFor, refusedFor);
  awaiting = shown.show === 'ring' ? shown.awaits : undefined;
  const at = shown.show === 'ring' || shown.show === 'blocked' ? shown.where : undefined;
  if (at && 'anchor' in at) askAbout(at.anchor);
  // Opening the pane that draws a routed step turns the answer into a ring, and a palette left up
  // over that ring covers the control the author is being sent to.
  if (routed && shown.show !== 'route') {
    routed = false;
    closePalette();
  }
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
 * What showing a step does beyond drawing it. Only a routed step acts: the palette stands in where
 * the app draws no control for the command.
 *
 * Nothing is said here. The overlay's banner carries the step for as long as the tour is on it,
 * where a notification would have scrolled away after a few seconds — which is what made a tour
 * started from the palette look like nothing had happened.
 */
function present(shown: Guidance): void {
  if (shown.show !== 'route') return;
  // The floor. `CommandForm` shows the command's own live verdict above its run button, so the
  // author sees the same refusal a control would have shown, and presses the button themselves.
  openPalette(shown.action.id, shown.action.props);
  routed = true;
}

/** The same answer with the tour's progress, which the banner needs and `guide` has no view of. */
function showingNow(): Showing | undefined {
  const state = running;
  const shown = shownNow();
  if (!state || !shown) return undefined;
  return { shown, title: state.tour.title, at: state.at, of: state.tour.steps.length };
}

/** The refusal standing against this anchor, for `guide` to read without awaiting anything. */
const refusedFor = (key: string): string | undefined => asked.get(key)?.reason;

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
  present(shown);
  if (shown.show === 'route') {
    // A routed answer comes from the swept map rather than from the screen, so explaining it means
    // saying how old that measurement is.
    const swept = `${SWEPT.at.slice(0, 10)} at ${SWEPT.sha.slice(0, 8)}`;
    return say(`${shown.say} No pane drew it when the map was swept, ${swept}.`);
  }
  if (shown.show === 'open') return say(`${shown.say} Open the ${shown.editor} pane first.`);
  if (shown.show === 'blocked') return say(`${shown.say} — ${shown.reason}`, true);
  say(shown.say);
}
