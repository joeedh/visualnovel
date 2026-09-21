/**
 * A runner files what it drew as the take its slot holds and nothing more: approval is a
 * person's, and a re-render leaves the approved take behind as history rather than clearing it.
 */
import { setArtNotes } from '@vn/artgen';
import { loadConfig } from '@vn/config';
import type { AnyTask, TaskInputs } from '@vn/types';
import { SCRIPTS, makeProject } from '@vn/testkit';

jest.setTimeout(120_000);

const BLOCKING =
  '{"reviewer":"r","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';

function locationRung(task: AnyTask): string {
  const inputs = task.inputs as TaskInputs['location_ref'];
  return `location:${inputs.locationId}/${inputs.variant}`;
}

describe('a run and the takes it files', () => {
  it('holds every picture it draws, accepts none, and stamps the row with the clock', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      let tick = 0;
      const now = () => new Date(Date.UTC(2026, 8, 20, 12, 0, tick++)).toISOString();
      const summary = await p.run({ now });
      const { store } = await p.reload();
      for (const task of summary.ran.filter((t) => t.status === 'done' && t.output)) {
        const row = store.get(task.output!)!;
        expect(row).toMatchObject({ current: true, accepted: false, via: 'run' });
        expect(row.at).toMatch(/^2026-09-20T12:00:/);
        expect(task.attempts.at(-1)).toMatchObject({ via: 'run', at: row.at });
      }
    } finally {
      await p.cleanup();
    }
  });

  it('leaves an approved take behind as history when its slot is drawn again', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      let { store } = await p.reload();
      const { graph } = await p.current();
      const plate = store.manifest().find((a) => a.kind === 'location_ref')!;
      await store.accept(plate.hash);
      const config = await loadConfig(p.dir);
      await setArtNotes(
        { config, paths: p.paths },
        { target: locationRung(graph.get(plate.sourceTask)!), notes: 'at dusk', mode: 'append' },
      );

      const second = await p.run();
      const redrawn = second.ran.find((t) => t.kind === 'location_ref' && t.status === 'done')!;
      expect(redrawn.output).not.toBe(plate.hash);
      ({ store } = await p.reload());
      expect(store.get(plate.hash)).toMatchObject({ current: false, accepted: true });
      expect(store.get(redrawn.output!)).toMatchObject({ current: true, accepted: false });
    } finally {
      await p.cleanup();
    }
  });

  it('holds the flawed frame a review sent to a person, so the author sees what was refused', async () => {
    const p = await makeProject({
      script: SCRIPTS.linear,
      config: { max_refine_attempts: 2, concurrency: 1 },
    });
    try {
      await p.run();
      await p.approve('aiko');
      const flagged = (await p.run({ reviewResponses: [BLOCKING] })).ran.find(
        (t) => t.status === 'needs_human',
      )!;
      const last = flagged.attempts.at(-1)!.output!;
      const { store } = await p.reload();
      expect(store.get(last)).toMatchObject({ current: true, accepted: false });
      // The earlier attempt of the same slot was released by the one that followed it.
      for (const attempt of flagged.attempts.slice(0, -1)) {
        if (attempt.output) expect(store.get(attempt.output)?.current).toBe(false);
      }
    } finally {
      await p.cleanup();
    }
  });
});
