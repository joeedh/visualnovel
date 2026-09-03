/**
 * Guided tours as commands, so the agent reaches them through the one door everything else uses
 * rather than through a channel of its own.
 *
 * They run in main like every other command and push an effect the renderer applies. Where a tour
 * has got to lives in the renderer, because only it knows what is drawn and what the author has
 * just clicked, so nothing here holds state.
 *
 * None of them writes anything: a tour tells the author what to press and never presses it.
 */
import { defineFor, prop } from '@vn/commands';
import { TOURS, tourById } from '../../shared/tours.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

const CURATED = TOURS.map((tour) => tour.id);
/** The curated ids, and the empty one that means `custom` carries the tour instead. */
const TOUR_VALUES = ['', ...CURATED];

export const tourStart = define({
  id: 'tour.start',
  title: 'Walk me through it',
  description:
    'Start a guided tour. Each step rings the control to press and says what it does, and the ' +
    'tour waits for you to press it — it never presses anything itself. `steps` carries a tour ' +
    'written for the moment, as JSON, and is what the agent uses; naming a curated tour instead ' +
    'runs one that ships with the app.',
  notes:
    'Starts a guided tour: each step rings the control to press and waits for the author to press it.',
  mutating: false,
  props: {
    tour: prop.oneOf(TOUR_VALUES, 'which curated tour to run; empty runs the one in `custom`', {
      default: '',
    }),
    custom: prop.string('a tour written for the moment, as JSON', { default: '' }),
  },
  run({ tour, custom }, ctx) {
    if (!tour && !custom)
      throw new Error('name a curated tour, or pass steps for one of your own.');
    ctx.host.ui(
      { type: 'tour', action: 'start', tour, ...(custom ? { steps: custom } : {}) },
      ctx.origin,
    );
    return Promise.resolve({
      message: tour ? `Walking through ${tourById(tour)?.title}.` : 'Walking through your steps.',
    });
  },
});

export const tourNext = define({
  id: 'tour.next',
  title: 'Skip to the next step',
  description:
    'Move the tour on without doing the step it is on. The tour advances by itself when you ' +
    'run the step, so this is for a step that no longer applies.',
  notes: 'Moves a running tour on without doing the step it is on.',
  mutating: false,
  props: {},
  run(_props, ctx) {
    ctx.host.ui({ type: 'tour', action: 'next' }, ctx.origin);
    return Promise.resolve({ message: 'Moved on.' });
  },
});

export const tourCancel = define({
  id: 'tour.cancel',
  title: 'Stop the tour',
  description: 'End the running tour. Nothing it walked you through is undone.',
  notes: 'Ends the running tour.',
  mutating: false,
  props: {},
  run(_props, ctx) {
    ctx.host.ui({ type: 'tour', action: 'cancel' }, ctx.origin);
    return Promise.resolve({ message: 'Tour ended.' });
  },
});

export const tourExplain = define({
  id: 'tour.explain',
  title: 'Say more about this step',
  description:
    'Say what the step the tour is on would do, where its control is, and why it is greyed if ' +
    'it is. The app answers from what is drawn rather than from the tour.',
  notes: 'Says what the step a running tour is on would do, and where its control is.',
  mutating: false,
  props: {},
  run(_props, ctx) {
    ctx.host.ui({ type: 'tour', action: 'explain' }, ctx.origin);
    return Promise.resolve({ message: 'Explaining the step.' });
  },
});
