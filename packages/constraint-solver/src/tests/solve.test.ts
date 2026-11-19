/**
 * The solver's generic loop and unit gate over the toy family in `garden.ts`, which shares nothing
 * with any real family.
 */
import { pins } from '@vn/contracts';
import { makeTask, taskHash } from '@vn/taskgraph';
import {
  identitySlotsBeforeTasks,
  projectRefusal,
  slot,
  solve,
  storageBaseUnavailable,
  unitGates,
} from '../index.js';
import {
  garden,
  log,
  planted,
  row,
  seedInputs,
  seedKind,
  sproutKind,
  type Garden,
} from './garden.js';

describe(pins(identitySlotsBeforeTasks), () => {
  describe('solve over a toy family', () => {
    it('enumerates every slot the family lists, once, with its unit', () => {
      const solved = solve(garden, planted());
      expect([...solved.slots.keys()]).toEqual([
        'seed:rose',
        'seed:fern',
        'sprout:r1',
        'sprout:f1',
      ]);
      expect(solved.slots.get('sprout:r1')).toMatchObject({
        kind : 'sprout',
        task : 'vision_review',
        label: 'sprout r1',
        unit : 'east',
      });
      expect(solved.slots.get('seed:rose')!.unit).toBeUndefined();
    });

    it('keeps the first enumeration of an address and drops the rest', () => {
      const solved = solve(garden, planted({ again: [slot(sproutKind, { id: 'r1' }, 'north')] }));
      expect(solved.slots.size).toBe(4);
      expect(solved.slots.get('sprout:r1')!.unit).toBe('east');
    });

    it('states the identity a kind can resolve, and reads its status from the task log', () => {
      const rose = makeTask('prompt_refine', seedInputs('rose'));
      const solved = solve(garden, planted({ tasks: log({ ...rose, status: 'running' }) }));
      const seed = solved.slots.get('seed:rose')!;
      expect(seed.taskHash).toBe(rose.hash);
      expect(seed.inputs).toEqual(seedInputs('rose'));
      expect(seed.status).toBe('running');
      expect(seed.blocked).toBeUndefined();
      expect(solved.slots.get('seed:fern')!.status).toBeUndefined();
    });

    it('gives a downstream slot no identity until its upstream is done, and then one built on it', () => {
      const before = solve(garden, planted()).slots.get('sprout:r1')!;
      expect(before.taskHash).toBeUndefined();
      expect(before.inputs).toBeUndefined();
      expect(before.blocked).toBe('seed rose has not grown yet');

      const rose = { ...makeTask('prompt_refine', seedInputs('rose')), status: 'done' as const };
      const after = solve(garden, planted({ tasks: log({ ...rose, output: 'petal' }) })).slots.get(
        'sprout:r1',
      )!;
      expect(after.blocked).toBeUndefined();
      expect(after.taskHash).toBe(
        taskHash('vision_review', { target: 'petal', spec: 'r1', refs: [], modelId: 'toy' }),
      );
    });

    it('asks a kind for its deps only once the slot has an identity', () => {
      const rose = makeTask('prompt_refine', seedInputs('rose'));
      expect(solve(garden, planted()).slots.get('sprout:r1')!.deps).toEqual([]);
      const grown = solve(
        garden,
        planted({ tasks: log({ ...rose, status: 'done', output: 'petal' }) }),
      );
      expect(grown.slots.get('sprout:r1')!.deps).toEqual([rose.hash]);
      // A kind with no `deps` runs after nothing
      expect(grown.slots.get('seed:rose')!.deps).toEqual([]);
    });

    it('carries the sentence a kind refuses with', () => {
      const solved = solve(
        garden,
        planted({ sprouts: [{ id: 'lost', seed: 'moss', bed: 'east' }] }),
      );
      expect(solved.slots.get('sprout:lost')!.blocked).toBe('sprout lost has no seed to grow from');
    });

    it('inverts the edges, keeping a ref to an address no slot has', () => {
      const solved = solve(
        garden,
        planted({
          sprouts: [
            { id: 'r1', seed: 'rose', bed: 'east' },
            { id: 'f1', seed: 'fern', bed: 'west', leans: ['r1', 'ghost'] },
          ],
        }),
      );
      expect(solved.slots.get('sprout:f1')!.refs).toEqual([
        'seed:fern',
        'sprout:r1',
        'sprout:ghost',
      ]);
      expect(solved.dependents.get('seed:rose')).toEqual(['sprout:r1']);
      expect(solved.dependents.get('sprout:r1')).toEqual(['sprout:f1']);
      expect(solved.dependents.get('sprout:ghost')).toEqual(['sprout:f1']);
      expect(solved.slots.has('sprout:ghost')).toBe(false);
    });

    it('orders upstream first, and names only enumerated slots', () => {
      const order = solve(garden, planted()).order;
      const at = (key: string): number => order.indexOf(key);
      expect(at('seed:rose')).toBeLessThan(at('sprout:r1'));
      expect(at('sprout:r1')).toBeLessThan(at('sprout:f1'));
      expect(at('seed:fern')).toBeLessThan(at('sprout:f1'));
      expect([...order].sort()).toEqual(['seed:fern', 'seed:rose', 'sprout:f1', 'sprout:r1']);
    });

    it('comes back from a cycle between slots instead of hanging on it', () => {
      const solved = solve(
        garden,
        planted({
          sprouts: [
            { id: 'a', seed: 'rose', bed: 'east', leans: ['b'] },
            { id: 'b', seed: 'rose', bed: 'east', leans: ['a'] },
          ],
        }),
      );
      expect([...solved.order].sort()).toEqual(['seed:fern', 'seed:rose', 'sprout:a', 'sprout:b']);
    });

    it('holds the take its own rule picks, lists the rows newest first, and asks the kind about approval', () => {
      const assets = [
        row('old', 'seed:rose', { accepted: true }),
        row('new', 'seed:rose', { current: true, at: '2026-01-01' }),
        row('kept', 'seed:fern', { current: true, accepted: true }),
      ];
      const solved = solve(garden, planted({ assets }));
      expect(solved.slots.get('seed:rose')).toMatchObject({
        pick      : 'new',
        candidates: ['new', 'old'],
        approved  : false,
      });
      expect(solved.slots.get('seed:fern')).toMatchObject({ pick: 'kept', approved: true });
      expect(solved.slots.get('sprout:r1')!.pick).toBeUndefined();
      expect(solved.slots.get('sprout:r1')!.candidates).toEqual([]);
    });

    it('reads an address back through the kind that wrote it', () => {
      for (const kind of garden.kinds) {
        expect(kind.parse(kind.key({ id: 'x' }))).toEqual({ id: 'x' });
      }
      expect(seedKind.parse('sprout:x')).toBeUndefined();
    });
  });
});

describe('the unit gate over a toy family', () => {
  const rose = { ...makeTask('prompt_refine', seedInputs('rose')), status: 'done' as const };
  const fern = { ...makeTask('prompt_refine', seedInputs('fern')), status: 'done' as const };
  /** Both seeds grown, so both sprouts have an identity. */
  const grown = (over: Partial<Garden> = {}): Garden =>
    planted({ tasks: log({ ...rose, output: 'petal' }, { ...fern, output: 'frond' }), ...over });

  it('holds a unit until every slot it waits on clears, and names the ones holding it', () => {
    const solved = solve(garden, grown({ beds: { east: ['seed:rose', 'seed:fern'] } }));
    expect(solved.units.get('east')).toEqual({
      gates  : ['seed:rose', 'seed:fern'],
      holding: ['seed:rose', 'seed:fern'],
      open   : false,
    });
    expect(solved.units.get('west')).toEqual({ gates: [], holding: [], open: true });
    // The held sprout has a task hash and is still not ready
    expect(solved.slots.get('sprout:r1')).toMatchObject({ ready: false });
    expect(solved.slots.get('sprout:r1')!.taskHash).toBeDefined();
    expect(solved.slots.get('sprout:f1')!.ready).toBe(true);
    // A slot with no unit waits on nothing
    expect(solved.slots.get('seed:rose')!.ready).toBe(true);
  });

  it('opens the unit once its slots clear', () => {
    const assets = [row('r', 'seed:rose', { accepted: true, current: true })];
    const solved = solve(garden, grown({ assets, beds: { east: ['seed:rose'] } }));
    expect(solved.units.get('east')).toMatchObject({ holding: [], open: true });
    expect(solved.slots.get('sprout:r1')!.ready).toBe(true);
  });

  it("asks a kind's `clears` rather than its `approved` where it has one", () => {
    // The held take is not accepted, so the seed is not approved, but an accepted row clears it
    const assets = [
      row('old', 'seed:rose', { accepted: true }),
      row('new', 'seed:rose', { current: true }),
    ];
    const solved = solve(garden, grown({ assets, beds: { east: ['seed:rose'] } }));
    expect(solved.slots.get('seed:rose')!.approved).toBe(false);
    expect(solved.units.get('east')!.open).toBe(true);
  });

  it('holds a unit on an address the family does not enumerate', () => {
    const solved = solve(garden, grown({ beds: { east: ['seed:moss'] } }));
    expect(solved.units.get('east')).toMatchObject({ holding: ['seed:moss'], open: false });
  });

  it('never makes a slot with no identity ready, whatever its gate says', () => {
    const solved = solve(garden, planted());
    expect(solved.units.get('east')!.open).toBe(true);
    expect(solved.slots.get('sprout:r1')!.ready).toBe(false);
  });

  it('reports the units the family owes, and `unitGates` answers what `solve` does', () => {
    const facts = grown({ fallow: ['north'], beds: { north: ['seed:fern'], east: ['seed:rose'] } });
    const solved = solve(garden, facts);
    expect([...solved.units.keys()]).toEqual(['east', 'west', 'north']);
    expect(solved.units.get('north')).toMatchObject({ holding: ['seed:fern'] });
    expect(unitGates(garden, facts)).toEqual(solved.units);
  });
});

describe(pins(storageBaseUnavailable), () => {
  const rose = { ...makeTask('prompt_refine', seedInputs('rose')), status: 'done' as const };
  const unavailable = { state: 'unavailable' as const, root: '/p/assets', count: 0 };

  it('refuses a project whose base root is unavailable, and makes no slot ready', () => {
    const facts = planted({ tasks: log({ ...rose, output: 'petal' }), base: unavailable });
    const solved = solve(garden, facts);
    expect(solved.refusal).toBe(projectRefusal(facts));
    expect(solved.refusal).toContain('/p/assets');
    // Identities are still stated, so a reader can show what is there
    expect(solved.slots.get('sprout:r1')!.taskHash).toBeDefined();
    expect([...solved.slots.values()].some((s) => s.ready)).toBe(false);
  });

  it('refuses nothing for a ready or absent root, or none at all', () => {
    for (const state of ['ready', 'absent'] as const) {
      const solved = solve(garden, planted({ base: { state, root: '/p/assets', count: 0 } }));
      expect(solved.refusal).toBeUndefined();
      expect(solved.slots.get('seed:rose')!.ready).toBe(true);
    }
    expect(solve(garden, planted()).refusal).toBeUndefined();
  });
});
