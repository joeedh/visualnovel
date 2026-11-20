/**
 * A toy family whose slots and units share nothing with any real family, so the solver's rules are
 * tested without a family package. A `seed` is drawn from nothing; a `sprout` is drawn from its seed's output, so it
 * has no identity until that seed's task is done, and it may lean on other sprouts. Manifest rows
 * are matched to a slot by `sourceTask`, which the toy sets to the address. A bed is a sprout's
 * unit, and waits on whichever slots `beds` names for it. Its two slot kinds borrow two of the
 * stills family's task kinds, because `TaskKind` names only the kinds a registered family declares;
 * the solver does nothing with a task kind but hash it and report it.
 */
import type { AnyTask, Asset, TaskInputs } from '@vn/types';
import { taskHash } from '@vn/taskgraph';
import { pick, slot, type Family, type Slot, type SlotKind, type SolverFacts } from '../index.js';

export interface Sprout {
  id: string;
  seed: string;
  bed: string;
  leans?: string[];
}

export interface Garden extends SolverFacts {
  seeds: string[];
  sprouts: Sprout[];
  /** Enumerated after everything else, to show that the first enumeration of an address wins. */
  again?: Slot<Garden>[];
  /** The slot addresses each bed waits on. */
  beds?: Record<string, string[]>;
  /** Beds with nothing sown in them yet. */
  fallow?: string[];
  /** Hashes the gardener's notebook names as a sprout's take. */
  notebook?: string[];
  /** Sprouts the gardener has noted as wilted since they were drawn. */
  wilted?: string[];
  /** Seeds no longer planted, whose art a collection still keeps. */
  dormant?: string[];
  /** Per row hash, the takes it was grafted from and the slot each was taken from. */
  grafts?: Record<string, { pin: string; from: string }[]>;
}

/** The task kind a seed's slot fills. */
export const SEED_TASK = 'portrait';

/** The task kind a sprout's slot fills. */
export const SPROUT_TASK = 'location_ref';

export const seedInputs = (id: string): TaskInputs[typeof SEED_TASK] => ({
  characterId: id,
  prompt     : '',
  refs       : [],
  params     : { modelId: 'toy' },
});

/** A sprout's inputs, drawn from its seed's output. */
export const sproutInputs = (seedOutput: string, id: string): TaskInputs[typeof SPROUT_TASK] => ({
  locationId: seedOutput,
  variant   : id,
  prompt    : '',
  refs      : [],
  params    : { modelId: 'toy' },
});

const rowsOf = (key: string, facts: Garden): Asset[] =>
  (facts.assets ?? []).filter((a) => a.sourceTask === key);

export const seedKind: SlotKind<Garden, { id: string }, typeof SEED_TASK> = {
  prefix    : 'seed',
  task      : SEED_TASK,
  key       : (b) => `seed:${b.id}`,
  parse     : (key) => (key.startsWith('seed:') ? { id: key.slice(5) } : undefined),
  label     : (b) => `seed ${b.id}`,
  refs      : () => [],
  resolve: (b, facts) =>
    facts.seeds.includes(b.id)
      ? { ok: true, plan: seedInputs(b.id) }
      : { ok: false, code: 'NO_SEED', reason: `no seed "${b.id}" is planted` },
  candidates: (b, facts) => rowsOf(`seed:${b.id}`, facts),
  approved  : (_b, _facts, held) => held.rows.some((a) => a.hash === held.pick && a.accepted),
  // Looser than `approved`: any accepted row clears a bed, held or not
  clears    : (_b, _facts, held) => held.rows.some((a) => a.accepted),
};

const sproutOf = (facts: Garden, id: string): Sprout | undefined =>
  facts.sprouts.find((s) => s.id === id);

export const sproutKind: SlotKind<Garden, { id: string }, typeof SPROUT_TASK> = {
  prefix    : 'sprout',
  task      : SPROUT_TASK,
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
    const grown = facts.tasks.get(taskHash(SEED_TASK, seedInputs(s.seed)));
    if (grown?.status !== 'done' || !grown.output)
      return { ok: false, code: 'NOT_GROWN', reason: `seed ${s.seed} has not grown yet` };
    return { ok: true, plan: sproutInputs(grown.output, b.id) };
  },
  deps: (b, facts) => {
    const s = sproutOf(facts, b.id);
    return s ? [taskHash(SEED_TASK, seedInputs(s.seed))] : [];
  },
  candidates: (b, facts) => rowsOf(`sprout:${b.id}`, facts),
  named     : (_b, facts) => new Set(facts.notebook ?? []),
  drift: (b, facts) =>
    facts.wilted?.includes(b.id) ? [{ source: 'wilt', reason: `sprout ${b.id} has wilted` }] : [],
  approved  : (_b, _facts, held) => held.rows.some((a) => a.hash === held.pick && a.accepted),
};

export const garden: Family<Garden> = {
  id   : 'garden',
  kinds: [seedKind, sproutKind],
  *enumerate(facts) {
    for (const id of facts.seeds) yield slot(seedKind, { id });
    for (const s of facts.sprouts) yield slot(sproutKind, { id: s.id }, s.bed);
    yield* facts.again ?? [];
  },
  *kept(facts) {
    yield* garden.enumerate(facts);
    for (const id of facts.dormant ?? []) yield slot(seedKind, { id });
  },
  owed     : (facts) => facts.fallow ?? [],
  gates    : (bed, facts) => facts.beds?.[bed] ?? [],
  slotOf: (row) => {
    const seed = seedKind.parse(row.sourceTask);
    if (seed) return slot(seedKind, seed);
    const sprout = sproutKind.parse(row.sourceTask);
    return sprout ? slot(sproutKind, sprout) : undefined;
  },
  drawnFrom: (row, facts) => {
    const grafts = facts.grafts?.[row.hash] ?? [];
    const refs = [...row.refs, ...grafts.map((g) => g.pin)];
    for (const { pin, from } of grafts) {
      const now = pick(rowsOf(from, facts));
      if (now !== undefined && now !== pin)
        return { refs, moved: `${from} moved from ${pin} to ${now}` };
    }
    return { refs };
  },
};

/** A task log holding exactly `tasks`, by hash. */
export const log = (...tasks: AnyTask[]): Garden['tasks'] => {
  const byHash = new Map(tasks.map((t) => [t.hash, t]));
  return { get: (hash) => byHash.get(hash) };
};

export const row = (hash: string, slotKey: string, over: Partial<Asset> = {}): Asset => ({
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

export const planted = (over: Partial<Garden> = {}): Garden => ({
  seeds  : ['rose', 'fern'],
  sprouts: [
    { id: 'r1', seed: 'rose', bed: 'east' },
    { id: 'f1', seed: 'fern', bed: 'west', leans: ['r1'] },
  ],
  tasks  : log(),
  ...over,
});
