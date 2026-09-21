/**
 * `current` is a cache of the task log. The migration stamps a manifest written before takes were
 * held, once; the repair keeps the bit true to the log on every open and run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Asset, ProjectModel } from '@vn/types';
import { AssetStore, type ProjectPaths } from '@vn/store';
import { logTask } from '@vn/taskgraph';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { migrateCurrent, openTakeDeps, repairCurrent, resolveBinding, slotOf } from '../index.js';

jest.setTimeout(60_000);

const BLOCKING =
  '{"reviewer":"r","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';

/** Strips every take field from both manifests: the shape a manifest had before this bit. */
async function unstamp(paths: ProjectPaths): Promise<void> {
  for (const file of [paths.manifest, paths.baseManifest]) {
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const doc = JSON.parse(text) as { assets: Record<string, unknown>[] };
    for (const row of doc.assets) {
      delete row['current'];
      delete row['at'];
      delete row['via'];
      const bindings = row['satisfies'];
      for (const b of Array.isArray(bindings) ? (bindings as Record<string, unknown>[]) : []) {
        delete b['angle'];
      }
    }
    await writeFile(file, JSON.stringify(doc));
  }
}

async function deps(p: TestProject) {
  const { config, model } = await p.reload();
  return openTakeDeps(p.paths, model, config);
}

/** The rows of `kind`, and the one the slot they serve resolves to. */
function held(assets: readonly Asset[], model: ProjectModel, kind: Asset['kind']) {
  const rows = assets.filter((a) => a.kind === kind);
  const slot = slotOf(rows[0]!)!;
  return { rows, slot, resolved: resolveBinding(slot, { model, assets }) };
}

describe('migrateCurrent', () => {
  it('stamps a manifest written before takes were held to what the log says, once', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      let tick = 0;
      const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
      await p.run({ now });
      await p.approve('aiko');
      await p.run({ now });
      const stamped = await deps(p);
      expect(stamped.store.unstamped).toBe(false);
      expect(await migrateCurrent(stamped)).toBeUndefined();

      await unstamp(p.paths);
      const d = await deps(p);
      expect(d.store.unstamped).toBe(true);
      const report = (await migrateCurrent(d))!;
      expect(Object.keys(report.held).length).toBeGreaterThan(0);

      // Every done task's output is what its slot now holds, stamped as the migration's choice.
      const assets = d.store.manifest();
      for (const task of d.graph.all().filter((t) => t.status === 'done' && t.output)) {
        const row = assets.find((a) => a.hash === task.output)!;
        expect(row).toMatchObject({ current: true, via: 'migrated' });
        expect(row.at).toBeDefined();
      }
      expect(d.store.unstamped).toBe(false);
      expect(await migrateCurrent(d)).toBeUndefined();

      // A sheet's binding now names its angle, off the task that drew it.
      const sheet = assets.find((a) => a.kind === 'model_sheet')!;
      expect(sheet.satisfies[0]!.angle).toBeDefined();
    } finally {
      await p.cleanup();
    }
  });

  it('picks the newest of two accepted rows when the identity is not done, then the lowest hash', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      let { store } = await p.reload();
      const { graph } = await p.current();
      const plate = store.manifest().find((a) => a.kind === 'location_ref')!;
      const task = graph.get(plate.sourceTask)!;
      await store.accept(plate.hash);
      // A second accepted row for the same slot, whose task the log does not have, and the
      // identity put back to pending: the shape two kept candidates leave behind
      const twin = await store.write(new TextEncoder().encode('another plate'), 'png', {
        kind      : 'location_ref',
        sourceTask: 'f'.repeat(64),
        modelId   : plate.modelId,
        satisfies : plate.satisfies[0]!,
        accepted  : true,
      });
      await logTask(p.paths, { ...task, status: 'pending', output: undefined, attempts: [] });
      await unstamp(p.paths);

      const d = await deps(p);
      await migrateCurrent(d);
      ({ store } = await p.reload());
      const { rows, resolved } = held(store.manifest(), d.model, 'location_ref');
      // The plate's own attempt is the only rendering time on record, so it is the newest.
      expect(resolved).toBe(plate.hash);
      expect(rows.find((a) => a.hash === twin.hash)).toMatchObject({
        current : false,
        accepted: true,
      });
    } finally {
      await p.cleanup();
    }
  });

  it('holds the flawed frame a review sent to a person, as the log does', async () => {
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
      await unstamp(p.paths);
      const d = await deps(p);
      const report = (await migrateCurrent(d))!;
      const key = Object.keys(report.held).find((k) => report.held[k] === last);
      expect(key).toMatch(/^shot:/);
      expect(d.store.get(last)).toMatchObject({ current: true });
    } finally {
      await p.cleanup();
    }
  });

  it('leaves a sheet with no task and no angle a candidate of no slot', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await p.approve('aiko');
      await p.run();
      const { store } = await p.reload();
      const sheet = store.manifest().find((a) => a.kind === 'model_sheet')!;
      const stray = await store.write(new TextEncoder().encode('a sheet from nowhere'), 'png', {
        kind      : 'model_sheet',
        sourceTask: 'e'.repeat(64),
        modelId   : sheet.modelId,
        satisfies: {
          characterId: sheet.satisfies[0]!.characterId!,
          outfit     : sheet.satisfies[0]!.outfit!,
        },
      });
      await unstamp(p.paths);
      const d = await deps(p);
      const report = (await migrateCurrent(d))!;
      expect(Object.values(report.held)).not.toContain(stray.hash);
      const row = d.store.get(stray.hash)!;
      expect(row.current).toBe(false);
      expect(row.satisfies[0]!.angle).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  });

  it('follows the log for a portrait too, and names the character the sheet approved otherwise', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      let { store, graph } = await p.reload();
      const portrait = store.manifest().find((a) => a.kind === 'portrait')!;
      // The sheet approves an older draft, while the identity's output is the rendered one.
      const older = await store.write(new TextEncoder().encode('the first draft'), 'png', {
        kind      : 'portrait',
        sourceTask: portrait.sourceTask,
        modelId   : portrait.modelId,
        satisfies : portrait.satisfies[0]!,
      });
      await p.approve('aiko', older.hash);
      await unstamp(p.paths);
      const d = await deps(p);
      const report = (await migrateCurrent(d))!;
      expect(report.held['portrait:aiko']).toBe(portrait.hash);
      expect(report.unapprovedPortraits).toEqual(['aiko']);
      ({ store, graph } = await p.reload());
      expect(graph.get(portrait.sourceTask)!.output).toBe(portrait.hash);
      expect(store.get(older.hash)).toMatchObject({ current: false, accepted: true });
    } finally {
      await p.cleanup();
    }
  });

  it('stamps base kinds filed in the build manifest before the split', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      // Move every base row into the project manifest, which is where a manifest written before
      // the split kept them; the bytes stay where they are, since only the row is read here.
      const base = JSON.parse(await readFile(p.paths.baseManifest, 'utf8')) as {
        assets: Record<string, unknown>[];
      };
      const project = JSON.parse(await readFile(p.paths.manifest, 'utf8')) as {
        assets: Record<string, unknown>[];
      };
      project.assets.push(...base.assets);
      base.assets = [];
      await writeFile(p.paths.baseManifest, JSON.stringify(base));
      await writeFile(p.paths.manifest, JSON.stringify(project));
      await unstamp(p.paths);

      const d = await deps(p);
      const report = (await migrateCurrent(d))!;
      expect(report.held['portrait:aiko']).toBeDefined();
      const reopened = await AssetStore.open(p.paths);
      expect(reopened.unstamped).toBe(false);
      expect(reopened.get(report.held['portrait:aiko']!)).toMatchObject({ current: true });
    } finally {
      await p.cleanup();
    }
  });
});

describe('repairCurrent', () => {
  it('rewrites the bit to the identity output where the task is done, and leaves a re-keyed slot alone', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      let d = await deps(p);
      expect(await repairCurrent(d)).toEqual([]);

      const plate = d.store.manifest().find((a) => a.kind === 'location_ref')!;
      const task = d.graph.get(plate.sourceTask)!;
      // The manifest row marks the plate not current while the task log has it as the done output
      await d.store.migrateTakes((row) => ({
        current: row.hash !== plate.hash && row.current === true,
      }));
      d = await deps(p);
      const fixes = await repairCurrent(d);
      expect(fixes.map((f) => f.keep)).toEqual([plate.hash]);
      expect(d.store.get(plate.hash)!.current).toBe(true);

      // With the identity put back to pending the row is authoritative, so nothing is rewritten.
      await d.store.migrateTakes((row) => ({
        current: row.hash !== plate.hash && row.current === true,
      }));
      await logTask(p.paths, { ...task, status: 'pending', output: undefined, attempts: [] });
      d = await deps(p);
      expect(await repairCurrent(d)).toEqual([]);
      expect(d.store.get(plate.hash)!.current).toBe(false);
    } finally {
      await p.cleanup();
    }
  });

  it('puts a slot with two current rows back to one', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      const { store } = await p.reload();
      const plate = store.manifest().find((a) => a.kind === 'location_ref')!;
      const twin = await store.write(new TextEncoder().encode('another plate'), 'png', {
        kind      : 'location_ref',
        sourceTask: 'f'.repeat(64),
        modelId   : plate.modelId,
        satisfies : plate.satisfies[0]!,
      });
      await store.migrateTakes((row) => ({
        current: row.current === true || row.hash === twin.hash,
      }));
      let d = await deps(p);
      expect(
        resolveBinding(slotOf(plate)!, { model: d.model, assets: d.store.manifest() }),
      ).toBeUndefined();

      const fixes = await repairCurrent(d);
      expect(fixes).toEqual([
        { slot: expect.stringMatching(/^plate:/), keep: plate.hash, drop: [twin.hash] },
      ]);
      d = await deps(p);
      expect(resolveBinding(slotOf(plate)!, { model: d.model, assets: d.store.manifest() })).toBe(
        plate.hash,
      );
      expect(await repairCurrent(d)).toEqual([]);
    } finally {
      await p.cleanup();
    }
  });

  it('runs the migration first, so an upgraded project resolves before it runs', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await unstamp(p.paths);
      const d = await deps(p);
      expect(d.store.unstamped).toBe(true);
      await repairCurrent(d);
      expect(d.store.unstamped).toBe(false);
      const { rows, resolved } = held(d.store.manifest(), d.model, 'location_ref');
      expect(rows.some((a) => a.hash === resolved)).toBe(true);
    } finally {
      await p.cleanup();
    }
  });
});
