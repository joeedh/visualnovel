/** What the Project pane's one write offers, and the refusals it draws Apply greyed for. */
import type { Offer } from './anchors.js';

/** The art style, typed into the box the pane's body is. */
export const STYLE_SUPPLIES = ['style'];

/**
 * Write the art style back to `project.yaml`. `project.setArtStyle` is `confirm: true`, so the
 * author is asked — with the count of image tasks it re-keys — before the file moves.
 */
export function applyStyleAction(opened: boolean, dirty: boolean): Offer {
  if (!opened) return { ok: false, id: 'project.setArtStyle', reason: 'No project is open.' };
  if (!dirty) return { ok: false, id: 'project.setArtStyle', reason: 'No changes' };
  return { ok: true, id: 'project.setArtStyle', props: {}, label: 'Apply' };
}
