/**
 * The portrait gate reads the manifest row: a character is approved when the take their portrait
 * slot holds is one a person accepted. The character sheet mirrors that row, written by `accept`
 * and cleared by `unaccept`, and is read only where there is no manifest in hand or the sheet says
 * `locked`.
 */
import { promises as fs } from 'node:fs';
import { loadConfig } from '@vn/config';
import { parseFrontMatter, stringifyFrontMatter } from '@vn/parse';
import type { Asset, Character } from '@vn/types';
import { SCRIPTS, character, location, makeProject, model, scene } from '@vn/testkit';
import {
  approvedPortraitOf,
  gateStatus,
  heldBy,
  isApproved,
  repairCurrent,
  setArtNotes,
} from '../index.js';

jest.setTimeout(120_000);

function portrait(hash: string, over: Partial<Asset> = {}): Asset {
  return {
    hash,
    ext       : 'png',
    kind      : 'portrait',
    sourceTask: `task-${hash}`,
    refs      : [],
    modelId   : 'm',
    accepted  : false,
    satisfies : [{ characterId: 'aiko' }],
    ...over,
  };
}

describe('approvedPortraitOf', () => {
  const aiko: Character = character('aiko', 'approved', 'p1');

  it('answers the current row a person accepted, and not an accepted row the slot moved past', () => {
    expect(approvedPortraitOf(aiko, [portrait('p1', { current: true, accepted: true })])).toBe(
      'p1',
    );
    // A re-render held `p2`; `p1` keeps its accepted bit as history and no longer clears the gate
    const redrawn = [
      portrait('p1', { current: false, accepted: true }),
      portrait('p2', { current: true }),
    ];
    expect(approvedPortraitOf(aiko, redrawn)).toBeUndefined();
    expect(isApproved(aiko, redrawn)).toBe(false);
    // Restoring `p1` reopens it
    expect(
      approvedPortraitOf(aiko, [
        portrait('p1', { current: true, accepted: true }),
        portrait('p2', { current: false }),
      ]),
    ).toBe('p1');
  });

  it('reads the sheet only without a manifest, and always when the sheet says locked', () => {
    expect(approvedPortraitOf(aiko)).toBe('p1');
    expect(approvedPortraitOf(character('aiko', 'candidates', 'p1'))).toBeUndefined();
    const locked = character('aiko', 'locked', 'p1');
    expect(approvedPortraitOf(locked, [])).toBe('p1');
    expect(approvedPortraitOf(locked, [portrait('p2', { current: true })])).toBe('p1');
  });

  it('feeds gateStatus, so the sheet alone clears nobody once there is a manifest', () => {
    const m = model([aiko], [scene('arrival', ['aiko'], 'cafe')], [location('cafe')]);
    expect(gateStatus(m).cleared).toBe(true);
    expect(gateStatus(m, [portrait('p1', { current: true })])).toMatchObject({
      cleared: false,
      pending: ['aiko'],
    });
    expect(gateStatus(m, [portrait('p1', { current: true, accepted: true })]).cleared).toBe(true);
  });
});

describe('the sheet as a mirror of the row', () => {
  it('is written by accept, cleared by unaccept, and follows the slot through a re-render', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      const sheet = async () => parseFrontMatter(await p.read('characters/aiko/character.md')).data;
      expect((await sheet())['status']).not.toBe('approved');

      const first = await p.approve('aiko');
      expect(await sheet()).toMatchObject({ status: 'approved', approved_portrait: first });
      await expect(fs.stat(p.paths.approvedPortrait('aiko'))).resolves.toBeTruthy();
      let { model: m, store } = await p.reload();
      expect(approvedPortraitOf(m.characters.get('aiko')!, store.manifest())).toBe(first);

      // A re-render puts an unapproved draft in the slot: the gate closes, and the mirror still
      // names the take it was approved with
      const config = await loadConfig(p.dir);
      await setArtNotes(
        { config, paths: p.paths },
        { target: 'character:aiko', notes: 'freckles', mode: 'append' },
      );
      await p.run();
      ({ model: m, store } = await p.reload());
      const drafts = store.manifest().filter((a) => a.kind === 'portrait' && a.hash !== first);
      expect(drafts).toHaveLength(1);
      const draft = drafts[0]!;
      expect(draft).toMatchObject({ current: true, accepted: false });
      expect(store.get(first)).toMatchObject({ current: false, accepted: true });
      expect(approvedPortraitOf(m.characters.get('aiko')!, store.manifest())).toBeUndefined();
      expect(gateStatus(m, store.manifest()).pending).toEqual(['aiko']);
      expect((await sheet())['approved_portrait']).toBe(first);

      // Restoring the approved take reopens the gate without a second approval
      await store.hold(first, heldBy(store.get(first)!, { model: m, assets: store.manifest() }));
      ({ model: m, store } = await p.reload());
      expect(approvedPortraitOf(m.characters.get('aiko')!, store.manifest())).toBe(first);

      // Un-accepting clears the mirror
      await store.unaccept(first);
      expect(await sheet()).toMatchObject({ status: 'candidates' });
      expect((await sheet())['approved_portrait']).toBeUndefined();
      await expect(fs.stat(p.paths.approvedPortrait('aiko'))).rejects.toThrow();
      ({ model: m, store } = await p.reload());
      expect(isApproved(m.characters.get('aiko')!, store.manifest())).toBe(false);
    } finally {
      await p.cleanup();
    }
  });

  it('is not written for an accepted take the slot no longer holds', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      const first = await p.approve('aiko');
      const config = await loadConfig(p.dir);
      await setArtNotes(
        { config, paths: p.paths },
        { target: 'character:aiko', notes: 'freckles', mode: 'append' },
      );
      await p.run();
      const { store } = await p.reload();
      const draft = store.manifest().find((a) => a.kind === 'portrait' && a.hash !== first)!;
      // Accepting the draft mirrors it; accepting the superseded take again is history and
      // leaves the mirror on the draft.
      await store.accept(draft.hash);
      const sheet = async () => parseFrontMatter(await p.read('characters/aiko/character.md')).data;
      expect((await sheet())['approved_portrait']).toBe(draft.hash);
      await store.accept(first);
      expect((await sheet())['approved_portrait']).toBe(draft.hash);
    } finally {
      await p.cleanup();
    }
  });

  it('catches up a sheet an older tool approved by hand, once', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      let { model: m, store, graph } = await p.reload();
      const row = store.manifest().find((a) => a.kind === 'portrait')!;
      const file = 'characters/aiko/character.md';
      const byHand = async () => {
        const doc = parseFrontMatter(await p.read(file));
        doc.data['status'] = 'approved';
        doc.data['approved_portrait'] = row.hash;
        await p.write(file, stringifyFrontMatter(doc.data, doc.body));
      };
      await byHand();

      ({ model: m, store, graph } = await p.reload());
      const config = await loadConfig(p.dir);
      const deps = { model: m, config, store, graph, shots: new Map() };
      const fixes = await repairCurrent(deps);
      expect(fixes).toEqual([{ slot: 'portrait:aiko', keep: row.hash, drop: [] }]);
      expect(store.get(row.hash)).toMatchObject({ current: true, accepted: true });
      expect(await repairCurrent(deps)).toEqual([]);

      // A sheet naming a hash while some row of the slot is accepted is a stale write, not a
      // mirror owed a row, and is left alone
      await store.unaccept(row.hash);
      await setArtNotes(
        { config, paths: p.paths },
        { target: 'character:aiko', notes: 'freckles', mode: 'append' },
      );
      await p.run();
      ({ model: m, store, graph } = await p.reload());
      const draft = store.manifest().find((a) => a.kind === 'portrait' && a.hash !== row.hash)!;
      await store.accept(draft.hash);
      await byHand();
      ({ model: m, store, graph } = await p.reload());
      expect(await repairCurrent({ model: m, config, store, graph, shots: new Map() })).toEqual([]);
      expect(store.get(row.hash)).toMatchObject({ current: false, accepted: false });
      expect(store.get(draft.hash)).toMatchObject({ current: true, accepted: true });
    } finally {
      await p.cleanup();
    }
  });
});
