/**
 * The solver over a toy family that shares nothing with any real one, so the generic loop is
 * tested without a family package. A `seed` is drawn from nothing; a `sprout` is drawn from its
 * seed's output, so it has no identity until that seed's task is done, and it may lean on other
 * sprouts. Manifest rows are matched to a slot by `sourceTask`, which the toy sets to the address.
 */
import type { AnyTask, Asset, TaskInputs } from '@vn/types';
import { makeTask, taskHash } from '@vn/taskgraph';
import { slot, solve, type Family, type Slot, type SlotKind, type SolverFacts } from '../index.js';

interface Sprout {
  id: string;
  seed: string;
  bed: string;
  leans?: string[];
}

interface Garden extends SolverFacts {
  seeds: string[];
  sprouts: Sprout[];
  /** Enumerated after everything else, to show that the first enumeration of an address wins. */
  again?: Slot<Garden>[];
}

const seedInputs = (id: string): TaskInputs['prompt_refine'] => ({
  basePrompt: id,
  defects   : '',
  modelId   : 'toy',
});

const rowsOf = (key: string, facts: Garden): Asset[] =>
  (facts.assets ?? []).filter((a) => a.sourceTask === key);

const current = (rows: readonly Asset[]): string | undefined => {
  const held = rows.filter((a) => a.current);
  return held.length === 1 ? held[0]!.hash : undefined;
};

const seedKind: SlotKind<Garden, { id: string }, 'prompt_refine'> = {
  prefix    : 'seed',
  task      : 'prompt_refine',
  key       : (b) => `seed:${b.id}`,
  parse     : (key) => (key.startsWith('seed:') ? { id: key.slice(5) } : undefined),
  label     : (b) => `seed ${b.id}`,
  refs      : () => [],
  resolve: (b, facts) =>
    facts.seeds.includes(b.id)
      ? { ok: true, plan: seedInputs(b.id) }
      : { ok: false, code: 'NO_SEED', reason: `no seed "${b.id}" is planted` },
  candidates: (b, facts) => rowsOf(`seed:${b.id}`, facts),
  pick      : (b, facts) => current(rowsOf(`seed:${b.id}`, facts)),
  approved  : (_b, _facts, held) => held.rows.some((a) => a.hash === held.pick && a.accepted),
};

const sproutOf = (facts: Garden, id: string): Sprout | undefined =>
  facts.sprouts.find((s) => s.id === id);

const sproutKind: SlotKind<Garden, { id: string }, 'vision_review'> = {
  prefix    : 'sprout',
  task      : 'vision_review',
  key       : (b) => `sprout:${b.id}`,
  parse     : (key) => (key.startsWith('sprout:') ? { id: key.slice(7) } : undefined),
  label     : (b) => `sprout ${b.id}`,
  refs: (b, facts) => {
    const s = sproutOf(facts, b.id);
    return s ? [`seed:${s.seed}`, ...(s.leans ?? []).map((id) => `sprout:${id}`)] : [];
  },
  resolve: (b, facts) => {
    const s = sproutOf(facts, b.id);
    if (!s || !facts.seeds.includes(s.seed))
      return { ok: false, code: 'NO_SEED', reason: `sprout ${b.id} has no seed to grow from` };
    const grown = facts.tasks.get(taskHash('prompt_refine', seedInputs(s.seed)));
    if (grown?.status !== 'done' || !grown.output)
      return { ok: false, code: 'NOT_GROWN', reason: `seed ${s.seed} has not grown yet` };
    return { ok: true, plan: { target: grown.output, spec: b.id, refs: [], modelId: 'toy' } };
  },
  candidates: (b, facts) => rowsOf(`sprout:${b.id}`, facts),
  pick      : (b, facts) => current(rowsOf(`sprout:${b.id}`, facts)),
  approved  : (_b, _facts, held) => held.rows.some((a) => a.hash === held.pick && a.accepted),
};

const garden: Family<Garden> = {
  id   : 'garden',
  kinds: [seedKind, sproutKind],
  *enumerate(facts) {
    for (const id of facts.seeds) yield slot(seedKind, { id });
    for (const s of facts.sprouts) yield slot(sproutKind, { id: s.id }, s.bed);
    yield* facts.again ?? [];
  },
};

/** A task log holding exactly `tasks`, by hash. */
const log = (...tasks: AnyTask[]): Garden['tasks'] => {
  const byHash = new Map(tasks.map((t) => [t.hash, t]));
  return { get: (hash) => byHash.get(hash) };
};

const row = (hash: string, slotKey: string, over: Partial<Asset> = {}): Asset => ({
  hash,
  ext       : 'png',
  kind      : 'reference',
  sourceTask: slotKey,
  refs      : [],
  modelId   : 'toy',
  satisfies : [],
  accepted  : false,
  ...over,
});

const planted = (over: Partial<Garden> = {}): Garden => ({
  seeds  : ['rose', 'fern'],
  sprouts: [
    { id: 'r1', seed: 'rose', bed: 'east' },
    { id: 'f1', seed: 'fern', bed: 'west', leans: ['r1'] },
  ],
  tasks  : log(),
  ...over,
});

describe('solve over a toy family', () => {
  it('enumerates every slot the family lists, once, with its unit', () => {
    const solved = solve(garden, planted());
    expect([...solved.slots.keys()]).toEqual(['seed:rose', 'seed:fern', 'sprout:r1', 'sprout:f1']);
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

  it('carries the sentence a kind refuses with', () => {
    const solved = solve(garden, planted({ sprouts: [{ id: 'lost', seed: 'moss', bed: 'east' }] }));
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
    expect(solved.slots.get('sprout:f1')!.refs).toEqual(['seed:fern', 'sprout:r1', 'sprout:ghost']);
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

  it('answers the take and approval through the kind, with the take it held', () => {
    const assets = [
      row('old', 'seed:rose', { accepted: true }),
      row('new', 'seed:rose', { current: true, at: '2026-01-01' }),
      row('kept', 'seed:fern', { current: true, accepted: true }),
    ];
    const solved = solve(garden, planted({ assets }));
    expect(solved.slots.get('seed:rose')).toMatchObject({
      pick      : 'new',
      candidates: ['old', 'new'],
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
