/** What the Project pane's one write offers, and the refusals it draws Apply greyed for. */
import { refuse, type Offer } from './anchors.js';

/** What the Project pane reads when it draws its bar. */
export interface ProjectBarState {
  opened: boolean;
  /** Whether the art-style box holds something `project.yaml` does not. */
  dirty: boolean;
}

/**
 * Write the art style back to `project.yaml`. `project.setArtStyle` is `confirm: true`, so the
 * author is asked — with the count of image tasks it re-keys — before the file moves. The style
 * itself is typed into the box the pane's body is, so the click supplies it.
 */
export function applyStyleAction(opened: boolean, dirty: boolean): Offer {
  const control = {
    id      : 'project.setArtStyle',
    label   : 'Apply',
    tooltip : 'Write these settings back to project.yaml',
    supplies: ['style'],
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  if (!dirty) return { ...refuse('No changes'), ...control };
  return { ok: true, props: {}, ...control };
}

/** Every offer the Project pane draws from this module. */
export function controls(state: ProjectBarState): readonly Offer[] {
  return [applyStyleAction(state.opened, state.dirty)];
}
