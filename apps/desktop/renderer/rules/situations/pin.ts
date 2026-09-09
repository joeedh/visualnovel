/** The pin toggle's situations, for one pinnable pane: following the selection, or held. */
import { PIN_NOUN, type PinField } from '../../../src/shared/editors.js';
import { situations, type Situation } from './situation.js';
import type { PinState } from '../pin.js';

export function pinSituations(field: PinField): readonly Situation<PinState>[] {
  const noun = PIN_NOUN[field];
  return situations<PinState>(
    {
      name : 'following',
      why  : `The pane follows the selected ${noun}, so the toggle offers to hold it.`,
      state: { pinned: false },
    },
    {
      name : 'pinned',
      why  : `The pane is held on one ${noun}, so the toggle offers to follow again.`,
      state: { pinned: true },
    },
  );
}
