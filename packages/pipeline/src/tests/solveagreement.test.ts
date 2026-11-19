/**
 * Stage 6a of `docs/plans/contracts-into-code-and-workflows.md`: `solve(stillsFamily, facts)`
 * answers what `buildSlotGraph(ctx)` answers, slot for slot, in the same order, with the same
 * dependents and the same approval order.
 *
 * The two are compared over the stage 1 oracle's fixtures after every planner wave, with and
 * without a manifest, and over every testkit script on disk as a run moves it from nothing drawn
 * to everything accepted. `SlotState` carries four fields a `SlotNode` does not (`kind`, `task`,
 * `unit`, `inputs`) and calls the held row `pick` where the node calls it `hash`; those are
 * checked on their own. This lives in `@vn/pipeline` because only the planner can move a project
 * through its waves.
 */
import { shotsOf, type Asset, type RefBinding } from '@vn/types';
import { TaskGraph, loadGraph, taskHash } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { solve, type SlotState } from '@vn/constraint-solver';
import {
  buildSlotGraph,
  resolveSlot,
  stillsFamily,
  type SlotGraphContext,
  type SlotNode,
  type StillsFacts,
} from '@vn/stills';
import { withProduction } from '@vn/store';
import { LISTED_ORDER, SCRIPTS, makeProject, type ScriptName, type TestProject } from '@vn/testkit';
import { planTasks } from '../index.js';
import { config, FIXTURES, ROWS, type Fixture } from './__fixtures__/projects.js';

/** The facts that say what `ctx` says; a context with no task log reads as an empty one. */
function factsOf(ctx: SlotGraphContext): StillsFacts {
  const { graph, ...rest } = ctx;
  return { ...rest, tasks: graph ?? { get: () => undefined } };
}

/** A slot state in a slot node's shape, for a strict comparison. */
function asNode(state: SlotState): SlotNode {
  const { kind: _kind, task: _task, unit: _unit, inputs: _inputs, pick, ...rest } = state;
  return {
    ...rest,
    binding: state.binding as RefBinding,
    refs   : [...state.refs],
    ...(pick ? { hash: pick } : {}),
    candidates: [...state.candidates],
  };
}

/** Checks the solver against the slot graph for one context, and returns how many slots it saw. */
function agree(ctx: SlotGraphContext): number {
  const graph = buildSlotGraph(ctx);
  const solved = solve(stillsFamily, factsOf(ctx));

  expect([...solved.slots.values()].map(asNode)).toStrictEqual([...graph.nodes.values()]);
  expect([...solved.dependents]).toStrictEqual([...graph.dependents]);
  expect(solved.order).toStrictEqual(graph.order);

  // What a slot node does not carry, checked against the functions the node is built from
  for (const state of solved.slots.values()) {
    const binding = state.binding as RefBinding;
    expect(state.kind).toBe(binding.kind);
    expect(state.unit).toBe(binding.kind === 'shot' ? binding.sceneId : undefined);
    const decided = resolveSlot(binding, ctx);
    if (decided.ok) {
      expect(state.task).toBe(decided.plan.kind);
      expect(state.inputs).toStrictEqual(decided.plan.inputs);
      expect(taskHash(state.task, state.inputs!)).toBe(state.taskHash);
    } else {
      expect(state.inputs).toBeUndefined();
    }
  }
  return solved.slots.size;
}

describe('the solver and the slot graph agree', () => {
  describe('over the stage 1 fixtures, after every planner wave', () => {
    for (const [name, fixture] of Object.entries(FIXTURES) as [string, Fixture][]) {
      it(name, async () => {
        const graph = new TaskGraph();
        const m = fixture.build();
        const providers = createMockProviders();
        // The planner reads its fixture's manifest; the slot graph is also asked with one that
        // approves the portrait and draws the plate, so shots and sheets state identities
        const manifests: (readonly Asset[])[] = [fixture.assets ?? [], ROWS];
        let identities = 0;

        expect(agree({ model: m, config, assets: [] })).toBeGreaterThan(0);
        for (let wave = 0; wave < 5; wave++) {
          for (const assets of manifests) agree({ model: m, config, assets, graph });
          await planTasks({
            model: m,
            graph,
            config,
            providers,
            ...(fixture.assets ? { assets: fixture.assets } : {}),
          });
          for (const t of graph.all()) {
            if (t.status === 'pending')
              graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
          }
        }
        for (const assets of manifests) {
          agree({ model: m, config, assets, graph });
          const shots = solve(stillsFamily, { model: m, config, assets, tasks: graph });
          identities += [...shots.slots.values()].filter(
            (s) => s.kind === 'shot' && s.taskHash,
          ).length;
        }
        // Each fixture has to reach a stated shot identity, or the comparison skipped the case
        expect(identities).toBeGreaterThan(0);
      });
    }
  });

  describe('over every testkit script on disk', () => {
    const names = Object.keys(SCRIPTS) as ScriptName[];

    for (const name of names) {
      describe(name, () => {
        let p: TestProject;

        /** Every context a reader builds from the project as it now stands on disk. */
        async function contexts(): Promise<SlotGraphContext[]> {
          const { model, config: cfg, store } = await p.reload();
          const graph = await loadGraph(p.paths);
          const angleOf = (sourceTask: string | undefined): string | undefined => {
            const task = sourceTask === undefined ? undefined : graph.get(sourceTask);
            return task && 'angle' in task.inputs ? task.inputs.angle : undefined;
          };
          const full = await withProduction(p.paths, model);
          const assets = store.manifest();
          return [
            // The planner's own model, whose production map holds nothing until it decomposes
            { model, config: cfg, assets, graph },
            { model: full, config: cfg, assets, graph },
            { model: full, config: cfg, assets, graph, angleOf },
            { model: full, config: cfg, assets },
          ];
        }

        beforeAll(async () => {
          p = await makeProject({
            script: SCRIPTS[name],
            ...(name === 'listed'
              ? { config: { narrative: 'linear', scenes: [...LISTED_ORDER] } }
              : {}),
          });
        }, 120_000);

        afterAll(async () => {
          await p.cleanup();
        });

        it('before anything is drawn, at the gate, once drawn and once accepted', async () => {
          for (const ctx of await contexts()) agree(ctx);

          await p.run();
          for (const ctx of await contexts()) agree(ctx);

          await p.approveAll();
          await p.run();
          const drawn = await contexts();
          for (const ctx of drawn) agree(ctx);
          const full = drawn[2]!;
          const scenes = [...full.model.scenes.keys()].filter(
            (id) => shotsOf(full.model, id).length > 0,
          );
          expect(scenes.length).toBeGreaterThan(0);

          await p.acceptAll();
          for (const ctx of await contexts()) agree(ctx);
        }, 120_000);
      });
    }
  });
});
