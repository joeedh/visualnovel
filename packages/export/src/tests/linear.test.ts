/**
 * A `narrative: linear` project end to end on disk: the planner draws exactly the listed scenes,
 * and the playable chains them in list order with plain `next` edges.
 */
import type { AnyTask, TaskInputs } from '@vn/types';
import { errors } from '@vn/model';
import { LISTED_ORDER, SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { buildPlayable, withSceneShots } from '../playable.js';

/** The scenes the run's `shot_image` tasks drew, each once, read off the `<scene>__` shot ids. */
const drawn = (tasks: readonly AnyTask[]): string[] => [
  ...new Set(
    tasks
      .filter((t) => t.kind === 'shot_image')
      .map((t) => (t.inputs as TaskInputs['shot_image']).shotId.split('__')[0]!),
  ),
];

/** Runs the mock pipeline until it stops, approving the cast at the gate. */
async function runThrough(p: TestProject): Promise<void> {
  await p.run();
  await p.approveAll();
  await p.run();
}

describe('a linear project', () => {
  it('draws every listed scene and plays them in list order', async () => {
    const p = await makeProject({
      script: SCRIPTS.listed,
      config: { narrative: 'linear', scenes: [...LISTED_ORDER] },
    });
    try {
      await runThrough(p);
      const { model, store, graph } = await p.reload();
      expect(errors(model)).toEqual([]);
      // The directory sorts the files by id; the story is the list's order
      expect([...model.scenes.keys()]).toEqual(['dusk', 'lunch', 'morning']);
      expect(model.narrative.scenes()).toEqual(LISTED_ORDER);
      expect(drawn(graph.all()).sort()).toEqual([...LISTED_ORDER].sort());

      const play = buildPlayable(await withSceneShots(p.paths, model), store);
      expect(play.start).toBe('morning');
      expect(play.scenes['morning']).toMatchObject({ choices: [], next: 'lunch' });
      expect(play.scenes['lunch']).toMatchObject({ choices: [], next: 'dusk' });
      expect(play.scenes['dusk']!.next).toBeUndefined();
      expect(play.scenes['dusk']!.beats.some((b) => b.type === 'show' && b.image)).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 60_000);

  it('draws nothing for a scene the list leaves out', async () => {
    const p = await makeProject({
      script: SCRIPTS.listed,
      config: { narrative: 'linear', scenes: ['morning', 'dusk'] },
    });
    try {
      await runThrough(p);
      const { model, store, graph } = await p.reload();
      expect(model.diagnostics.map((d) => [d.code, d.where])).toEqual([
        ['unlisted_scene', 'lunch'],
      ]);
      expect(model.reachable.has('lunch')).toBe(false);
      expect(drawn(graph.all()).sort()).toEqual(['dusk', 'morning']);

      const play = buildPlayable(await withSceneShots(p.paths, model), store);
      expect(play.scenes['morning']!.next).toBe('dusk');
      expect(play.scenes['lunch']).toMatchObject({ choices: [] });
      expect(play.scenes['lunch']!.next).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  }, 60_000);
});
