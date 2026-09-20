import type { ProjectModel, Scene } from '@vn/types';

/** Outgoing scene ids (choices + linear next) for a scene. */
export function successors(scene: Scene): string[] {
  const out = scene.choices.map((c) => c.goto);
  if (scene.next) out.push(scene.next);
  return out;
}

/** Compute the set of scenes reachable from `entry` via choice/next edges (report §6). */
export function computeReachable(
  scenes: Map<string, Scene>,
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
 * Emit a Mermaid flowchart of the branch structure (report §6 visualization →
 * `story.graph.mmd`). Unreachable scenes are dashed so dead nodes are visible.
 */
export function toMermaid(model: ProjectModel): string {
  const lines = ['flowchart TD'];
  for (const scene of model.scenes.values()) {
    const label = `${scene.id}`;
    lines.push(`  ${scene.id}["${label}"]`);
    if (!model.reachable.has(scene.id)) {
      lines.push(`  class ${scene.id} dead;`);
    }
    for (const choice of scene.choices) {
      const edge = choice.label ? `|${choice.label.replace(/"/g, "'")}|` : '';
      lines.push(`  ${scene.id} -->${edge} ${choice.goto}`);
    }
    if (scene.next) lines.push(`  ${scene.id} --> ${scene.next}`);
  }
  lines.push('  classDef dead stroke-dasharray: 5 5,stroke:#c33;');
  return lines.join('\n') + '\n';
}

/**
 * Orders the reachable scenes so that each comes after every scene that leads to it, starting
 * from `entry`. Among the scenes ready at once, the one a playthrough meets first goes first:
 * `next` ahead of `choices`, in breadth-first discovery order. A loop back to an earlier scene
 * cannot be honoured, so when nothing is ready the scene discovered earliest is released and the
 * walk continues. Scenes the entry does not reach are absent; `computeReachable` names them.
 */
export function topologicalOrder(scenes: Map<string, Scene>, entry: string | undefined): string[] {
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
