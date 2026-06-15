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
