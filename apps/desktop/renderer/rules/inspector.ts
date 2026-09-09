/** What the Inspector's bar offers: one re-read, whatever task is on screen. */
import type { Offer } from './anchors.js';
import { view } from './effects.js';

/** What the Inspector reads when it draws its bar. */
export interface InspectorState {
  /** Whether a task is on screen; the bar is the same either way. */
  shown: boolean;
}

export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : 'Refresh',
    tooltip: 'Re-read this task, its attempts and its prompt from disk',
  };
}

/** Every offer the Inspector draws from this module. */
export function controls(_state: InspectorState): readonly Offer[] {
  return [reloadAction()];
}
