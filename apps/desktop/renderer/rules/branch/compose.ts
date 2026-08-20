/**
 * The two structural acts the branch editor owns: making a scene from nothing, and removing one.
 *
 * Both change the set of scenes rather than any scene's prose, which is why they live on the
 * canvas. `newScene` has a second home in the script column ("a scene after this one", which also
 * wires it). `deleteScene` has only this one, because offering it from inside the prose of the
 * scene being deleted risks losing work.
 */
import type { Intent } from '../../../src/shared/interactions.js';
import type { Invocation } from '@vn/commands';
import type { StoryGraph } from '../../../src/shared/ipc';

/**
 * A scene id nothing has taken. The name is generic on purpose: a scene made on an empty canvas
 * has no neighbour to derive a name from, and the id is a prefill the author types over. It is
 * underscored because that is what `slug` produces, and `story.newScene` refuses an id that is not
 * already its own slug.
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

/** A scene made here is deliberately unwired; wiring it is a separate act on the canvas. */
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
 * Where the room's selection goes when the selected scene is deleted. Prefers the entry scene,
 * otherwise the first scene left. Null when no scene is left, and the surfaces then show their
 * empty invite. Takes the graph as it was before the delete, which is what says which scenes
 * survive it.
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
