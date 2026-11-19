/**
 * A toy family that shares nothing with any real one, so the solver's rules are tested without a
 * family package. A `seed` is drawn from nothing; a `sprout` is drawn from its seed's output, so it
 * has no identity until that seed's task is done, and it may lean on other sprouts. Manifest rows
 * are matched to a slot by `sourceTask`, which the toy sets to the address. A bed is a sprout's
 * unit, and waits on whichever slots `beds` names for it.
 */
import type { AnyTask, Asset, TaskInputs } from '@vn/types';
import { taskHash } from '@vn/taskgraph';
import { slot, type Family, type Slot, type SlotKind, type SolverFacts } from '../index.js';

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
}

export const seedInputs = (id: string): TaskInputs['prompt_refine'] => ({
  basePrompt: id,
  defects   : '',
  modelId   : 'toy',
});

const rowsOf = (key: string, facts: Garden): Asset[] =>
  (facts.assets ?? []).filter((a) => a.sourceTask === key);

export const seedKind: SlotKind<Garden, { id: string }, 'prompt_refine'> = {
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
  approved  : (_b, _facts, held) => held.rows.some((a) => a.hash === held.pick && a.accepted),
  // Looser than `approved`: any accepted row clears a bed, held or not
  clears    : (_b, _facts, held) => held.rows.some((a) => a.accepted),
};

const sproutOf = (facts: Garden, id: string): Sprout | undefined =>
  facts.sprouts.find((s) => s.id === id);

export const sproutKind: SlotKind<Garden, { id: string }, 'vision_review'> = {
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
  deps: (b, facts) => {
    const s = sproutOf(facts, b.id);
    return s ? [taskHash('prompt_refine', seedInputs(s.seed))] : [];
  },
  candidates: (b, facts) => rowsOf(`sprout:${b.id}`, facts),
  named     : (_b, facts) => new Set(facts.notebook ?? []),
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
  owed  : (facts) => facts.fallow ?? [],
  gates : (bed, facts) => facts.beds?.[bed] ?? [],
  slotOf: (row) => {
    const seed = seedKind.parse(row.sourceTask);
    if (seed) return slot(seedKind, seed);
    const sprout = sproutKind.parse(row.sourceTask);
    return sprout ? slot(sproutKind, sprout) : undefined;
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
