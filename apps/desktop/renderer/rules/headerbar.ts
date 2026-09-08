/**
 * What the header's own buttons offer. Split out of the editor so the invocation each one runs is
 * a value a test can read, which is what lets the anchor and the click come from one object.
 *
 * Undo and redo are absent on purpose: they go through `command:undo` and `command:redo` rather
 * than through the registry, so there is no id for a tour step to name.
 */
import { refuse, type Offer } from './anchors.js';
import { busyControls, type BusyControls } from './busy.js';

/** What the header reads when it draws its three command buttons. */
export interface HeaderState {
  /** Which long-running work is in flight, or an empty string. */
  busyWhat: string;
  /** Whether this window can call a model, as opposed to a browser preview. */
  live: boolean;
  agentMode: string;
}

/**
 * Start a run. `mock` follows whether this is a live app rather than the author's intent: a browser
 * preview has no keys and no main process, so a dry run is the only thing it could do.
 */
export function runAction(busy: string, live: boolean): Offer {
  const label = '▶ Run';
  const tooltip = live
    ? 'Plan and render everything that is ready, to the next gate'
    : 'Preview what a run would do. This window cannot call a model.';
  if (busy !== '') {
    return {
      ...refuse(`Cannot start: ${busy} is already in progress.`),
      id: 'pipeline.run',
      label,
      tooltip,
    };
  }
  return { ok: true, id: 'pipeline.run', props: { mock: !live }, label, tooltip };
}

/** Stop whatever the header is showing a spinner for. Refuses when nothing it stops is running. */
export function stopAction(controls: BusyControls | undefined): Offer {
  if (!controls) {
    return {
      ...refuse('Nothing is running.'),
      id     : 'pipeline.stop',
      label  : '■',
      tooltip: 'Stop the work in progress after the step it is on',
    };
  }
  return { ok: true, id: controls.stop, props: {}, label: '■', tooltip: controls.stops };
}

/** Flip the agent between reading and writing. The label names the mode the agent is in now. */
export function modeAction(mode: string): Offer {
  const plan = mode === 'plan';
  return {
    ok     : true,
    id     : 'agent.setMode',
    props  : { mode: plan ? 'execute' : 'plan' },
    label  : plan ? 'PLAN' : 'EXECUTE',
    tooltip: plan
      ? 'Plan mode: the agent reads but never writes. Click to let it apply edits.'
      : 'Execute mode: the agent may apply edits. Click to make it read-only again.',
  };
}

/** Every offer the header draws from this module, in the order it draws them. */
export function controls(state: HeaderState): readonly Offer[] {
  return [
    runAction(state.busyWhat, state.live),
    stopAction(busyControls(state.busyWhat)),
    modeAction(state.agentMode),
  ];
}
