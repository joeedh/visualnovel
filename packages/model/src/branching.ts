/**
 * The `branching` narrative engine: a scene's `[[choice:]]` and `[[next:]]` markers are its
 * edges, play starts at `start:`, and a scene is live when the entry reaches it.
 */
import type { Diagnostic, NarrativeStructure, Scene, SceneExits } from '@vn/types';

/** Outgoing scene ids (choices + linear next) for a scene. */
export function successors(scene: Scene): string[] {
  const out = scene.choices.map((c) => c.goto);
  if (scene.next) out.push(scene.next);
  return out;
}

/** Compute the set of scenes reachable from `entry` via choice/next edges (report §6). */
export function computeReachable(
  scenes: ReadonlyMap<string, Scene>,
  entry: string | undefined,
): Set<string> {
  const reachable = new Set<string>();
  if (!entry || !scenes.has(entry)) return reachable;
  const stack = [entry];
  while (stack.length) {
    const id = stack.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const scene = scenes.get(id);
    if (!scene) continue;
    for (const next of successors(scene)) {
      if (scenes.has(next) && !reachable.has(next)) stack.push(next);
    }
  }
  return reachable;
}

/**
 * Orders the reachable scenes so that each comes after every scene that leads to it, starting
 * from `entry`. Among the scenes ready at once, the one a playthrough meets first goes first:
 * `next` ahead of `choices`, in breadth-first discovery order. A loop back to an earlier scene
 * cannot be honoured, so when nothing is ready the scene discovered earliest is released and the
 * walk continues. Scenes the entry does not reach are absent; `computeReachable` names them.
 */
export function topologicalOrder(
  scenes: ReadonlyMap<string, Scene>,
  entry: string | undefined,
): string[] {
  const reachable = computeReachable(scenes, entry);
  if (reachable.size === 0) return [];

  const discovered: string[] = [];
  const queue = [entry as string];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    discovered.push(id);
    const scene = scenes.get(id) as Scene;
    if (scene.next && scenes.has(scene.next)) queue.push(scene.next);
    for (const choice of scene.choices) if (scenes.has(choice.goto)) queue.push(choice.goto);
  }

  // How many predecessors of each scene are still unplaced. Two edges into the same scene from
  // one source count once, so they are released together.
  const leadsTo = (id: string): Set<string> =>
    new Set(successors(scenes.get(id) as Scene).filter((to) => reachable.has(to)));
  const waiting = new Map(discovered.map((id) => [id, 0]));
  for (const id of discovered) {
    for (const to of leadsTo(id)) waiting.set(to, (waiting.get(to) as number) + 1);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (placed.size < discovered.length) {
    const left = discovered.filter((id) => !placed.has(id));
    const id = left.find((each) => waiting.get(each) === 0) ?? (left[0] as string);
    placed.add(id);
    ordered.push(id);
    for (const to of leadsTo(id)) {
      if (!placed.has(to)) waiting.set(to, (waiting.get(to) as number) - 1);
    }
  }
  return ordered;
}

/** Where a branching project starts. */
export interface BranchingEntry {
  /** `project.yaml`'s `start:`. */
  start?: string;
  /**
   * Whether the scenes arrived with a document order (one screenplay) whose first scene stands in
   * for a missing `start:`. Scene chunks have none.
   */
  ordered?: boolean;
}

/**
 * The entry scene. A chunk project has no document order to fall back on, so a missing `start:`
 * is an error naming the fix rather than the scene whose filename sorts first, because an entry
 * chosen alphabetically moves silently the day a scene is renamed.
 */
function entryOf(
  scenes: ReadonlyMap<string, Scene>,
  opts: BranchingEntry,
  diagnostics: Diagnostic[],
): string | undefined {
  if (opts.start === undefined) {
    if (opts.ordered) return scenes.keys().next().value;
    if (scenes.size > 0) {
      diagnostics.push({
        severity: 'error',
        code    : 'missing_start',
        message: `project.yaml has no start:, and scenes/ has no order to take an entry scene from; add start: <scene id>`,
      });
    }
    return undefined;
  }
  if (!scenes.has(opts.start)) {
    diagnostics.push({
      severity: 'error',
      code    : 'unknown_start',
      message : `project.yaml start: names unknown scene "${opts.start}"`,
      where   : opts.start,
    });
    return undefined;
  }
  return opts.start;
}

/**
 * Reads the branch structure the scenes' markers describe. Live means reachable from the entry;
 * the scene order is the reachable scenes in {@link topologicalOrder}, then the rest in the order
 * the map holds them.
 */
export function branchingNarrative(
  scenes: ReadonlyMap<string, Scene>,
  opts: BranchingEntry = {},
): NarrativeStructure {
  const diagnostics: Diagnostic[] = [];
  const entry = entryOf(scenes, opts, diagnostics);
  const reachable = computeReachable(scenes, entry);

  for (const scene of scenes.values()) {
    for (const next of successors(scene)) {
      if (!scenes.has(next)) {
        diagnostics.push({
          severity: 'error',
          code    : 'dangling_goto',
          message : `scene "${scene.id}" points to unknown scene "${next}"`,
          where   : scene.id,
        });
      }
    }
    if (!reachable.has(scene.id)) {
      diagnostics.push({
        severity: 'warning',
        code    : 'unreachable_scene',
        message : `scene "${scene.id}" is unreachable from the entry scene`,
        where   : scene.id,
      });
    }
  }

  const order = [
    ...topologicalOrder(scenes, entry),
    ...[...scenes.keys()].filter((id) => !reachable.has(id)),
  ];
  return {
    engine: 'branching',
    entry,
    scenes     : () => order,
    live       : (id) => reachable.has(id),
    exits: (id): SceneExits => {
      const scene = scenes.get(id);
      if (!scene) return { choices: [] };
      return { choices: scene.choices, ...(scene.next ? { next: scene.next } : {}) };
    },
    diagnostics: () => diagnostics,
  };
}
