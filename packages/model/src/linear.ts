/**
 * The `linear` narrative engine: the story is the scenes `project.yaml`'s `scenes:` lists, played
 * in that order. Every listed scene is live and continues to the next one.
 */
import type { Diagnostic, NarrativeStructure, Scene, SceneExits } from '@vn/types';
import { successors } from './branching.js';

/** What a linear project says about its order. */
export interface LinearOrder {
  /** `project.yaml`'s `scenes:`; absent when the file has no list. */
  scenes?: readonly string[];
  /** `project.yaml`'s `start:`, which may only repeat the first listed scene. */
  start?: string;
}

/**
 * Reads the story as the list orders it. A listed id with no scene, a repeated id, a branch
 * marker, a `start:` naming anything but the first scene, and a missing list are errors; a scene
 * the list leaves out is a warning, and is not live.
 */
export function linearNarrative(
  scenes: ReadonlyMap<string, Scene>,
  order: LinearOrder = {},
): NarrativeStructure {
  const diagnostics: Diagnostic[] = [];
  const listed: string[] = [];

  if (order.scenes === undefined || order.scenes.length === 0) {
    if (scenes.size > 0) {
      diagnostics.push({
        severity: 'error',
        code    : 'missing_scene_list',
        message:
          `narrative: linear plays the scenes project.yaml lists under scenes:, and it lists none; ` +
          `add scenes: with these in order: ${[...scenes.keys()].join(', ')}`,
      });
    }
  }
  for (const id of order.scenes ?? []) {
    if (listed.includes(id)) {
      diagnostics.push({
        severity: 'error',
        code    : 'duplicate_listed_scene',
        message : `project.yaml scenes: lists "${id}" more than once; a scene plays once`,
        where   : id,
      });
    } else if (!scenes.has(id)) {
      diagnostics.push({
        severity: 'error',
        code    : 'unknown_listed_scene',
        message : `project.yaml scenes: lists "${id}", which has no scene file`,
        where   : id,
      });
    } else {
      listed.push(id);
    }
  }

  const entry = listed[0];
  if (order.start !== undefined && order.start !== entry) {
    diagnostics.push({
      severity: 'error',
      code    : 'linear_start',
      message:
        `project.yaml start: names "${order.start}", but a linear project starts at the first ` +
        `scene under scenes:${entry === undefined ? '' : ` ("${entry}")`}; remove start:`,
      where   : order.start,
    });
  }

  const live = new Set(listed);
  for (const scene of scenes.values()) {
    if (successors(scene).length > 0) {
      diagnostics.push({
        severity: 'error',
        code    : 'linear_branch_marker',
        message:
          `scene "${scene.id}" has a [[choice:]] or [[next:]] marker, which a linear project ` +
          `does not follow; remove it, since the order comes from scenes: in project.yaml`,
        where   : scene.id,
      });
    }
    if (!live.has(scene.id) && order.scenes?.length) {
      diagnostics.push({
        severity: 'warning',
        code    : 'unlisted_scene',
        message: `scene "${scene.id}" is not under scenes: in project.yaml, so it is not in the story`,
        where   : scene.id,
      });
    }
  }

  const sceneOrder = [...listed, ...[...scenes.keys()].filter((id) => !live.has(id))];
  return {
    engine: 'linear',
    entry,
    scenes     : () => sceneOrder,
    live       : (id) => live.has(id),
    exits: (id): SceneExits => {
      const next = live.has(id) ? listed[listed.indexOf(id) + 1] : undefined;
      return { choices: [], ...(next === undefined ? {} : { next }) };
    },
    diagnostics: () => diagnostics,
  };
}
