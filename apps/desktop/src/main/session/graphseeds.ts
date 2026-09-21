/**
 * What an interactive run seeds a graph with, derived for the slot its target output binds, so
 * `gengraph.run` draws what the scheduled run would draw. The prompt and the references are the
 * slot's own task inputs, as `resolveSlot` states them and the planner hashes them, so the record
 * the run files names the pictures the graph was actually shown. A shot in a staging-sheet group
 * seeds the sheet's prompt and references beside its own.
 */
import { parseSlot, resolveSlot, sheetSeeds, type Decided } from '@vn/artgen';
import { genNodeSpec } from '@vn/gengraph';
import type { Graph, GraphId } from '@vn/gengraph';
import type { GenExecuteOptions } from '@vn/gengraph/state';
import { readShots } from '@vn/store';
import type { AssetRef, RefBinding } from '@vn/types';
import type { LoadedProject } from './core.js';
import { readAllShots } from './core.js';

export type GraphSeeds = NonNullable<GenExecuteOptions['seeds']>;

/** What a run to one target is seeded with, and the slot it files its picture as, if any. */
export interface GraphRunPlan {
  seeds: GraphSeeds;
  /** The slot the target binds. Absent for an unbound target, whose run stays journal-only. */
  slot?: RefBinding;
}

/** The slot the target binds, when the target is an output node naming one. */
export function boundSlot(graph: Graph, target: GraphId): RefBinding | undefined {
  const node = graph.nodeIdMap.get(target);
  const key = node === undefined ? undefined : genNodeSpec(node.def.typeName)?.slotProp;
  if (node === undefined || key === undefined) return undefined;
  const said = node.props[key]?.getValue();
  return typeof said === 'string' ? parseSlot(said) : undefined;
}

function seedsOf(
  prompt: string,
  refs: readonly AssetRef[],
  sheet?: { prompt: string; refs: readonly AssetRef[] },
): GraphSeeds {
  return {
    GenDerivedPrompt: { prompt },
    GenTaskRefs     : { assets: JSON.stringify(refs) },
    ...(sheet === undefined
      ? {}
      : {
          GenSheetPrompt: { prompt: sheet.prompt },
          GenSheetRefs  : { assets: JSON.stringify(sheet.refs) },
        }),
  };
}

/**
 * The plan for a run to `target`. A target that is no output seeds nothing, and the graph's
 * seeded nodes run on their empty defaults, as they did before any host seeded them. A bound
 * target whose identity the project cannot state yet is refused with the resolver's sentence,
 * because a run to it would draw from pictures the record could not name.
 */
export async function graphRunPlan(
  project: LoadedProject,
  graph: Graph,
  target: GraphId,
): Promise<Decided<GraphRunPlan>> {
  const slot = boundSlot(graph, target);
  if (slot === undefined) return { ok: true, plan: { seeds: {} } };

  const { model, config } = project;
  const shots = await readAllShots(project);
  const resolved = resolveSlot(slot, { model, shots, config, graph: project.graph });
  if (!resolved.ok) return resolved;
  const { prompt, refs } = resolved.plan.inputs;

  // A member of a staging sheet also seeds the sheet the graph crops it from, read again from
  // the storyboard because the group's seed lives beside the shots rather than on them
  let sheet: { prompt: string; refs: readonly AssetRef[] } | undefined;
  if (slot.kind === 'shot') {
    const scene = model.scenes.get(slot.sceneId);
    const shot = shots.get(slot.sceneId)?.find((s) => s.id === slot.shotId);
    if (scene && shot?.sheet !== undefined) {
      const loaded = await readShots(
        project.paths,
        scene.id,
        new Set(scene.lines.map((l) => l.id)),
      );
      if (loaded) {
        const board = {
          ...scene,
          shots: loaded.shots,
          ...(loaded.sheets ? { sheets: loaded.sheets } : {}),
        };
        sheet = sheetSeeds(board, shot.sheet, model, config, project.store.manifest());
      }
    }
  }
  return { ok: true, plan: { seeds: seedsOf(prompt, refs, sheet), slot } };
}
