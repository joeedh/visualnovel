/**
 * Project the validated `ProjectModel` into the flat scene/edge shape the branch editor
 * draws. Pure, and deliberately narrower than the model: the editor needs structure and
 * enough of a card face to recognise a scene, not the screenplay text.
 */
import type { ProjectModel } from '@vn/types';
import type { StoryEdge, StoryGraph, StoryScene } from '../shared/ipc.js';

/**
 * Edge ids are `<from>#choice:<index>` / `<from>#next`. They are stable across reloads, so a
 * selection survives a rebuild, and unique because a scene has one `next` and one choice per
 * index. The id carries exactly the arguments `story.removeChoice` and `story.setNext` need, so
 * a drag on a wire maps back to a command without a lookup table.
 */
export const choiceEdgeId = (from: string, index: number): string => `${from}#choice:${index}`;
export const nextEdgeId = (from: string): string => `${from}#next`;

export function storyGraphOf(model: ProjectModel): StoryGraph {
  const scenes: StoryScene[] = [];
  const edges: StoryEdge[] = [];

  for (const scene of model.scenes.values()) {
    scenes.push({
      id      : scene.id,
      location: scene.location,
      ...(scene.synopsis !== undefined ? { synopsis: scene.synopsis } : {}),
      characters: [...scene.characters],
      lines     : scene.lines.length,
      reachable : model.reachable.has(scene.id),
    });

    scene.choices.forEach((choice, index) => {
      edges.push({
        id   : choiceEdgeId(scene.id, index),
        from : scene.id,
        to   : choice.goto,
        kind : 'choice',
        label: choice.label,
        index,
        dangling: !model.scenes.has(choice.goto),
      });
    });

    if (scene.next !== undefined) {
      edges.push({
        id      : nextEdgeId(scene.id),
        from    : scene.id,
        to      : scene.next,
        kind    : 'next',
        dangling: !model.scenes.has(scene.next),
        // The runner only follows `next` when a scene has no choices, but `computeReachable`
        // counts it either way. Emitting it flagged rather than hiding it keeps the editor
        // agreeing with `model.reachable` and puts the dead marker where it can be deleted.
        ...(scene.choices.length > 0 ? { inert: true } : {}),
      });
    }
  }

  return {
    ...(model.entry !== undefined ? { start: model.entry } : {}),
    scenes,
    edges,
    diagnostics: model.diagnostics,
  };
}
