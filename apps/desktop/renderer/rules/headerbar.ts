/**
 * What the header's own buttons offer. Split out of the editor so the invocation each one runs is
 * a value a test can read, which is what lets the anchor and the click come from one object.
 *
 * Undo and redo are absent on purpose: they go through `command:undo` and `command:redo` rather
 * than through the registry, so there is no id for a tour step to name.
 */
import type { Offer } from './anchors.js';
import type { BusyControls } from './busy.js';

/** Prop names the header's menus read from the author's choice rather than from the bar. */
export const MODEL_SUPPLIES = ['modelId'];
export const EDITOR_SUPPLIES = ['editor'];
export const LAYOUT_SUPPLIES = ['name'];

/**
 * Start a run. `mock` follows whether this is a live app rather than the author's intent: a browser
 * preview has no keys and no main process, so a dry run is the only thing it could do.
 */
export function runAction(busy: string, live: boolean): Offer {
  if (busy !== '') {
    return {
      ok    : false,
      id    : 'pipeline.run',
      reason: `Cannot start: ${busy} is already in progress.`,
    };
  }
  return { ok: true, id: 'pipeline.run', props: { mock: !live }, label: '▶ Run' };
}

/** Stop whatever the header is showing a spinner for. Refuses when nothing it stops is running. */
export function stopAction(controls: BusyControls | undefined): Offer {
  if (!controls) return { ok: false, id: 'pipeline.stop', reason: 'Nothing is running.' };
  return { ok: true, id: controls.stop, props: {}, label: '■' };
}

/** Flip the agent between reading and writing. The label names the mode the agent is in now. */
export function modeAction(mode: string): Offer {
  const next = mode === 'plan' ? 'execute' : 'plan';
  return {
    ok   : true,
    id   : 'agent.setMode',
    props: { mode: next },
    label: mode === 'plan' ? 'PLAN' : 'EXECUTE',
  };
}
