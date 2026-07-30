/**
 * The two structural acts the branch editor owns: making a scene from nothing, and removing one.
 *
 * Both are about the *set* of scenes rather than about any scene's prose, which is why they live on
 * the canvas. `newScene` has a second home in the script column — "a scene after this one", which
 * also wires it — but `deleteScene` has only this one: offering it from inside the prose of the
 * scene being deleted is an invitation to lose work.
 */
import type { Intent } from '../../../../src/shared/interactions.js';
import type { Invocation } from '@vn/commands';
import type { StoryGraph } from '../../../../src/shared/ipc';

/**
 * A scene id nothing has taken. Generic on purpose: a scene made on empty canvas has no neighbour
 * to derive a name from, and it is a prefill the author types over. Underscored because that is
 * what `slug` produces and `story.newScene` refuses an id that is not already its own slug.
 */
export function freeSceneId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `scene_${n}`;
    if (!used.has(id)) return id;
  }
}

/** A new scene as the canvas proposes it: an id and a heading, both prefills. */
export interface NewScene {
  scene: string;
  heading: string;
}

export function proposeScene(story: StoryGraph | null): NewScene {
  return {
    scene: freeSceneId((story?.scenes ?? []).map((s) => s.id)),
    heading: 'INT. SOMEWHERE - DAY',
  };
}

/** A scene made here is deliberately unwired — the canvas is where you then wire it. */
export const newSceneIntent = (next: NewScene): Intent => ({
  id: 'story.newScene',
  props: { scene: next.scene, heading: next.heading },
  note: `Wrote ${next.scene}.`,
});

export const deleteSceneIntent = (scene: string): Intent => ({
  id: 'story.deleteScene',
  props: { scene },
  note: `Removed ${scene}.`,
});

/**
 * Where the room's selection goes when the selected scene is deleted: the entry scene, or whatever
 * is left. `null` when nothing is — the surfaces show their empty invite then. Given the graph as
 * it was *before* the delete, which is what says which scenes survive it.
 */
export function selectionAfterDelete(story: StoryGraph | null, deleted: string): string | null {
  const left = (story?.scenes ?? []).map((s) => s.id).filter((id) => id !== deleted);
  if (story?.start && story.start !== deleted) return story.start;
  return left[0] ?? null;
}

/** The same invocation, for the `check` a hover asks before the click runs it. */
export const asInvocation = (intent: Intent): Invocation => ({
  id: intent.id,
  props: intent.props,
});
