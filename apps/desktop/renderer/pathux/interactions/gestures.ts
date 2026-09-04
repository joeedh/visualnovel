/**
 * What a gesture would do right now, asked without a pointer going down.
 *
 * `Interaction.targets` is synchronous and pure, but the state it is judged against belongs to
 * whichever surface draws the gesture — the branch editor's story graph, one scene's coverage, one
 * asset's chunks. So each surface leaves its state here as it redraws, and a tour asks by
 * interaction id rather than knowing which pane holds what.
 *
 * The registry is keyed by namespace because that is how the state divides: `main`'s `stateFor`
 * splits `interaction.targets` the same way, and for the same reason.
 */
import type { Verdict } from '@vn/commands';
import { createDesktopInteractions } from '../../../src/shared/interactions.js';
import type { AnchorHome } from '../../rules/anchors.js';

const interactions = createDesktopInteractions();

interface Source {
  editor: AnchorHome;
  read: () => unknown;
}

const states = new Map<string, Source>();

/**
 * Say which editor draws a namespace's gestures and where its state can be read. Replaces whatever
 * was registered for that namespace, and `read` is called on each question, so a surface registers
 * once and redraws freely.
 *
 * The editor is named because two panes can draw a card for the same scene, and only the one
 * running the gesture is somewhere a drag can start. A pane that has closed leaves its entry
 * behind — path.ux detaches an area on a tab switch without redrawing it when the tab returns, so
 * the entry cannot be dropped — and {@link verdictsFor} passes over it because the editor is not
 * in the open set.
 */
export function gestureState(namespace: string, editor: AnchorHome, read: () => unknown): void {
  states.set(namespace, { editor, read });
}

/**
 * Every target of a gesture, judged, and the editor whose cards the author would drag between.
 * Undefined where the interaction is unknown or no open surface left the state it is judged
 * against, which a tour reports rather than treating as a refusal.
 *
 * A closed pane's state is the second of those. Its verdicts describe a screen the author is not
 * looking at, and a tour reads the refusal in them before it resolves anything, so it would report
 * a closed pane's answer as the step's.
 */
export function verdictsFor(
  id: string,
  carried: string,
  open: readonly AnchorHome[],
): { editor: AnchorHome; verdicts: readonly Verdict[] } | undefined {
  const interaction = interactions.get(id);
  const source = states.get(id.split('.')[0] ?? '');
  if (!interaction || !source || !open.includes(source.editor)) return undefined;
  return { editor: source.editor, verdicts: interaction.targets(source.read(), carried) };
}
