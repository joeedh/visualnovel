/**
 * Lets a family be registered over facts other than its own. A host builds one shape of facts for
 * every workflow, and a family that reads fields of its own is wrapped with a builder that derives
 * them, so the host never names the family's facts type.
 */
import type { Family, Slot, SlotKind, SolverFacts } from './family.js';

/** The fields a family's facts carry beyond the ones the solver reads. */
export type OwnFacts<F extends SolverFacts> = Omit<F, keyof SolverFacts>;

/** Rebuilds a kind over the host's facts, asking `factsOf` for the family's facts on each call. */
function hostKind<H extends SolverFacts, F extends SolverFacts>(
  kind: SlotKind<F>,
  factsOf: (host: H) => F,
): SlotKind<H> {
  const { deps, named, drift, clears } = kind;
  return {
    prefix: kind.prefix,
    task  : kind.task,
    ...(kind.retired === undefined ? {} : { retired: kind.retired }),
    ...(kind.contracts === undefined ? {} : { contracts: kind.contracts }),
    key       : (binding) => kind.key(binding),
    parse     : (key) => kind.parse(key),
    label     : (binding) => kind.label(binding),
    refs      : (binding, host) => kind.refs(binding, factsOf(host)),
    resolve   : (binding, host) => kind.resolve(binding, factsOf(host)),
    fromInputs: (inputs, host) => kind.fromInputs(inputs, factsOf(host)),
    candidates: (binding, host) => kind.candidates(binding, factsOf(host)),
    approved  : (binding, host, held) => kind.approved(binding, factsOf(host), held),
    ...(deps === undefined ? {} : { deps: (binding, host) => deps(binding, factsOf(host)) }),
    ...(named === undefined ? {} : { named: (binding, host) => named(binding, factsOf(host)) }),
    ...(drift === undefined ? {} : { drift: (binding, host) => drift(binding, factsOf(host)) }),
    ...(clears === undefined
      ? {}
      : { clears: (binding, host, held) => clears(binding, factsOf(host), held) }),
  };
}

/**
 * Wraps `family` so it is solved over a host's facts `H`. `build` answers the family's own fields
 * once per host facts object, and the solver's fields are the host's, so the solver and the family
 * read the same manifest and task log. Each kind is wrapped once, so every slot the returned
 * family answers names a kind in the returned family's `kinds`.
 */
export function withFacts<H extends SolverFacts, F extends SolverFacts>(
  family: Family<F>,
  build: (host: H) => OwnFacts<F>,
): Family<H> {
  const built = new WeakMap<H, F>();
  const factsOf = (host: H): F => {
    let facts = built.get(host);
    if (!facts) built.set(host, (facts = { ...host, ...build(host) } as unknown as F));
    return facts;
  };

  const kinds = new Map<SlotKind<F>, SlotKind<H>>();
  const kindOf = (kind: SlotKind<F>): SlotKind<H> => {
    let wrapped = kinds.get(kind);
    if (!wrapped) kinds.set(kind, (wrapped = hostKind(kind, factsOf)));
    return wrapped;
  };
  const onHost = ({ kind, binding, unit }: Slot<F>): Slot<H> =>
    unit === undefined ? { kind: kindOf(kind), binding } : { kind: kindOf(kind), binding, unit };

  return {
    id   : family.id,
    kinds: family.kinds.map(kindOf),
    *enumerate(host) {
      for (const found of family.enumerate(factsOf(host))) yield onHost(found);
    },
    *kept(host) {
      for (const found of family.kept(factsOf(host))) yield onHost(found);
    },
    owed     : (host) => family.owed(factsOf(host)),
    gates    : (unit, host) => family.gates(unit, factsOf(host)),
    slotOf: (row, host) => {
      const found = family.slotOf(row, factsOf(host));
      return found && onHost(found);
    },
    drawnFrom: (row, host) => family.drawnFrom(row, factsOf(host)),
  };
}
