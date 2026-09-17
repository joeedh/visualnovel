/**
 * A slot holding two accepted takes resolves to nothing, so nothing that reads the slot can name
 * its picture. Repair puts it back to one, before a run and on demand.
 */
import { resolveBinding } from '@vn/artgen';
import { SCRIPTS, makeProject } from '@vn/testkit';
import { repairAccepted } from '../repair.js';

jest.setTimeout(60_000);

describe('repairAccepted', () => {
  it('leaves one accepted take in an over-accepted slot, and a clean manifest alone', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      let { model, store, graph } = await p.reload();
      expect(await repairAccepted({ model, store, graph })).toEqual([]);

      // A second take written as accepted, with nothing superseded: the state a manifest is in
      // once two candidates for one slot have both been kept.
      const plate = store.manifest().find((a) => a.kind === 'location_ref')!;
      const binding = plate.satisfies[0]!;
      const slot = {
        kind      : 'plate' as const,
        locationId: binding.locationId!,
        variant   : binding.variant!,
      };
      await store.accept(plate.hash);
      const twin = await store.write(new TextEncoder().encode('another plate'), 'png', {
        kind      : 'location_ref',
        sourceTask: plate.sourceTask,
        modelId   : plate.modelId,
        satisfies : binding,
        accepted  : true,
      });
      ({ model, store, graph } = await p.reload());
      const unresolved = resolveBinding(slot, { model, assets: store.manifest() });
      expect(unresolved).toBeUndefined();

      const fixes = await repairAccepted({ model, store, graph });
      expect(fixes).toHaveLength(1);
      expect(new Set([fixes[0]!.keep, ...fixes[0]!.drop])).toEqual(
        new Set([plate.hash, twin.hash]),
      );
      ({ model, store, graph } = await p.reload());
      const accepted = store
        .manifest()
        .filter(
          (a) =>
            a.kind === 'location_ref' &&
            a.accepted &&
            a.satisfies.some((b) => b.locationId === slot.locationId && b.variant === slot.variant),
        );
      expect(accepted).toHaveLength(1);
      expect(resolveBinding(slot, { model, assets: store.manifest() })).toBe(fixes[0]!.keep);
      expect(await repairAccepted({ model, store, graph })).toEqual([]);
    } finally {
      await p.cleanup();
    }
  });

  it('runs before the pipeline plans, so a run starts from a manifest that resolves', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      const { store } = await p.reload();
      const plate = store.manifest().find((a) => a.kind === 'location_ref')!;
      await store.accept(plate.hash);
      await store.write(new TextEncoder().encode('another plate'), 'png', {
        kind      : 'location_ref',
        sourceTask: plate.sourceTask,
        modelId   : plate.modelId,
        satisfies : plate.satisfies[0]!,
        accepted  : true,
      });

      await p.run();
      const after = (await p.reload()).store
        .manifest()
        .filter(
          (a) =>
            a.kind === 'location_ref' &&
            a.accepted &&
            a.satisfies[0]?.locationId === plate.satisfies[0]!.locationId,
        );
      expect(after).toHaveLength(1);
    } finally {
      await p.cleanup();
    }
  });
});
