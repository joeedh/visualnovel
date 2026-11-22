/**
 * Tests `withFacts` over the toy family in `garden.ts`, solved over host facts that carry the
 * garden's own fields under one key. A family wrapped this way must answer exactly what it answers
 * over its own facts.
 */
import type { AnyTask } from '@vn/types';
import { makeTask } from '@vn/taskgraph';
import {
  keepSet,
  solve,
  suspensions,
  taskSlot,
  unitGates,
  withFacts,
  type Family,
  type SolverFacts,
} from '../index.js';
import {
  garden,
  log,
  planted,
  row,
  seedInputs,
  seedKind,
  sproutKind,
  SEED_TASK,
  type Garden,
} from './garden.js';

/** Host facts that nest the garden's own fields under one key, a shape no family's facts take. */
interface Shed extends SolverFacts {
  plot: Omit<Garden, keyof SolverFacts>;
}

/** Builds the shed for a planted garden, with the solver's fields at its top level. */
function shed(over: Partial<Garden> = {}): Shed {
  const { assets, tasks, base, graphs, ...plot } = planted(over);
  return {
    tasks,
    ...(assets === undefined ? {} : { assets }),
    ...(base === undefined ? {} : { base }),
    ...(graphs === undefined ? {} : { graphs }),
    plot,
  };
}

/** Answers the garden facts the shed describes. */
const unpack = (host: Shed): Garden => ({ ...host, ...host.plot });

const rose = {
  ...makeTask(SEED_TASK, seedInputs('rose')),
  status: 'done' as const,
  output: 'petal',
};

/** Answers a garden with a grown seed, rows, a gated bed, a wilted sprout and a moved graft. */
const busy = (): Partial<Garden> => ({
  tasks   : log(rose),
  assets: [
    row('r-rose', 'seed:rose', { accepted: true, current: true }),
    row('r-r1', 'sprout:r1'),
    row('r-f1', 'sprout:f1'),
  ],
  beds    : { east: ['seed:rose'], west: ['seed:fern'] },
  fallow  : ['north'],
  wilted  : ['r1'],
  dormant : ['moss'],
  grafts  : { 'r-f1': [{ pin: 'old', from: 'seed:rose' }] },
  notebook: ['r-r1'],
});

describe('withFacts', () => {
  it('answers what the family answers over its own facts', () => {
    const host = shed(busy());
    const wrapped = withFacts(garden, (h: Shed) => h.plot);
    expect(solve(wrapped, host)).toEqual(solve(garden, unpack(host)));
    expect(unitGates(wrapped, host)).toEqual(unitGates(garden, unpack(host)));
    expect(suspensions(wrapped, host)).toEqual(suspensions(garden, unpack(host)));
    expect(keepSet(wrapped, host)).toEqual(keepSet(garden, unpack(host)));
  });

  it("reads the solver's fields from the host's facts", () => {
    const wrapped = withFacts(garden, (h: Shed) => h.plot);
    // The sprout can state an identity only because the host's task log holds the grown seed
    const sprout = solve(wrapped, shed(busy())).slots.get('sprout:r1')!;
    expect(sprout.taskHash).toBeDefined();
    expect(sprout.candidates).toEqual(['r-r1']);
  });

  it('builds the family facts once per host facts object', () => {
    let builds = 0;
    const wrapped = withFacts(garden, (h: Shed) => {
      builds += 1;
      return h.plot;
    });
    const host = shed(busy());
    solve(wrapped, host);
    keepSet(wrapped, host);
    expect(builds).toBe(1);
    solve(wrapped, shed(busy()));
    expect(builds).toBe(2);
  });

  it('hands out the same wrapped kind for a kind wherever a slot names it', () => {
    const wrapped = withFacts(garden, (h: Shed) => h.plot);
    const host = shed(busy());
    const kinds = new Set(wrapped.kinds);
    expect(kinds.size).toBe(garden.kinds.length);
    for (const found of [...wrapped.enumerate(host), ...wrapped.kept(host)])
      expect(kinds.has(found.kind)).toBe(true);
    expect(kinds.has(wrapped.slotOf(row('r', 'seed:rose'), host)!.kind)).toBe(true);
    expect(wrapped.kinds.map((k) => [k.prefix, k.task])).toEqual(
      garden.kinds.map((k) => [k.prefix, k.task]),
    );
  });

  it("reads a task's slot through the wrapped kind, retired kinds included", () => {
    // Binds only a planted seed, so the answer shows that `fromInputs` saw the family's facts
    const keeper = {
      ...seedKind,
      retired   : ['outfit_sheet'],
      fromInputs: (inputs: { characterId?: string }, facts: Garden) =>
        inputs.characterId && facts.seeds.includes(inputs.characterId)
          ? { id: inputs.characterId }
          : undefined,
    };
    const keeping: Family<Garden> = { ...garden, kinds: [keeper, sproutKind] };
    const wrapped = withFacts(keeping, (h: Shed) => h.plot);
    const host = shed(busy());

    expect(wrapped.kinds[0]!.retired).toEqual(['outfit_sheet']);
    const old = (characterId: string) =>
      ({ kind: 'outfit_sheet', inputs: { characterId } }) as unknown as AnyTask;
    expect(taskSlot(wrapped, old('rose'), host)).toEqual({
      kind   : wrapped.kinds[0],
      binding: { id: 'rose' },
    });
    expect(taskSlot(wrapped, old('moss'), host)).toBeUndefined();
  });
});
