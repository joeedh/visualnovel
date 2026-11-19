import type { ProjectModel } from '@vn/types';

/**
 * Emit a Mermaid flowchart of the story's structure (report §6 visualization →
 * `story.graph.mmd`), with the edges the narrative engine plays. Scenes that are not live are
 * dashed so dead nodes are visible.
 */
export function toMermaid(model: ProjectModel): string {
  const lines = ['flowchart TD'];
  for (const scene of model.scenes.values()) {
    const label = `${scene.id}`;
    lines.push(`  ${scene.id}["${label}"]`);
    if (!model.reachable.has(scene.id)) {
      lines.push(`  class ${scene.id} dead;`);
    }
    const exits = model.narrative.exits(scene.id);
    for (const choice of exits.choices) {
      const edge = choice.label ? `|${choice.label.replace(/"/g, "'")}|` : '';
      lines.push(`  ${scene.id} -->${edge} ${choice.goto}`);
    }
    if (exits.next) lines.push(`  ${scene.id} --> ${exits.next}`);
  }
  lines.push('  classDef dead stroke-dasharray: 5 5,stroke:#c33;');
  return lines.join('\n') + '\n';
}
