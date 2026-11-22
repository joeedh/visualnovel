/**
 * The generic loop: every slot a family enumerates, with the identity its kind can state for it
 * today, the reason it cannot, and the edges between slots inverted.
 *
 * A task hash covers the whole inputs object, and a downstream task's inputs embed its upstream's
 * output, so a downstream slot has no hash until its upstream has been drawn. Slots exist before
 * any of that, which is why the solver enumerates slots and attaches a hash only where it can.
 */
import type { TaskInputs, TaskKind, TaskStatus } from '@vn/types';
import { contract } from '@vn/contracts';
import { taskHash } from '@vn/taskgraph';
import type { Family, Held, SlotKind, SolverFacts } from './family.js';
import { boundDrift, type DriftReason } from './drift.js';
import { projectRefusal } from './refuse.js';
import { suspensions } from './suspend.js';
import { newestFirst, pick } from './take.js';

/** What the solver answers for one slot. */
export interface SlotState {
  /** The kind's `key(binding)`: the identity, stable across re-plans. */
  key: string;
  /** The kind's prefix. */
  kind: string;
  task: TaskKind;
  binding: unknown;
  label: string;
  unit?: string;
  /** Upstream addresses, which may name a slot the solution has no entry for. */
  refs: readonly string[];
  /** The task identity, where the kind can state one. */
  taskHash?: string;
  inputs?: TaskInputs[TaskKind];
  /** Task hashes the slot's task runs after, from the kind's `deps`; empty without an identity. */
  deps: readonly string[];
  /** The kind's sentence saying why no identity can be stated. */
  blocked?: string;
  status?: TaskStatus;
  /** The row the slot holds, by {@link pick}, where the answer is certain. */
  pick?: string;
  /** Every manifest row bound here, newest first ({@link newestFirst}). */
  candidates: readonly string[];
  approved: boolean;
  /** The take the slot holds is one `suspensions` lists. */
  suspended: boolean;
  /**
   * Why the slot's picture is out of date although its task hash has not moved: the kind's own
   * reasons, then its bound graph's.
   */
  drift: readonly DriftReason[];
  /**
   * True for a slot with an identity whose unit, if it has one, is open, in a project nothing
   * refuses. The planner adds exactly these.
   */
  ready: boolean;
}

/** What one unit waits on, from the family's `gates`. */
export interface UnitGate {
  /** The addresses of the slots the unit waits on, as the family listed them. */
  gates: readonly string[];
  /** The addresses in `gates` whose slot has not cleared, in the same order. */
  holding: readonly string[];
  /** No slot is holding the unit. */
  open: boolean;
}

/** Every slot, keyed by address, with its edges inverted and an upstream-first order. */
export interface Solution {
  slots: Map<string, SlotState>;
  /** Slot address → the slots drawn from it. */
  dependents: Map<string, string[]>;
  /** Upstream before downstream: the order approval has to happen in. */
  order: string[];
  /** Every unit a slot names or the family owes, with what it waits on. */
  units: Map<string, UnitGate>;
  /** Why `projectRefusal` refuses the whole project, when it does; no slot is ready then. */
  refusal?: string;
}

export const identitySlotsBeforeTasks = contract({
  id      : 'identity.slotsBeforeTasks',
  rule: "`solve` enumerates a family's slots whether or not anything has been drawn, and attaches a task hash only to a slot whose kind can resolve its inputs now; any other slot carries the kind's sentence saying why. Edges come from each kind's `refs`, never from `Task.deps`.",
  prevents:
    'A graph of task hashes cannot show work not yet planned, because a downstream hash embeds its upstream outputs, so every surface would have to guess at it.',
  subjects: [
    'package:packages/constraint-solver',
    'module:packages/constraint-solver/src/solve.ts',
    'function:packages/constraint-solver/src/solve.ts#solve',
  ],
  see: [
    'docs/reference/contracts.md#the-constraint-solver',
  ],
  detail:
    'The first enumeration of an address wins and later ones are dropped. `Solution.order` is ' +
    'upstream first, and a walk that meets a reference cycle already on disk stops rather than ' +
    'hanging. A ref to an address with no slot is an opaque upstream, such as an authored pin. ' +
    '`Task.deps` is incomplete and is not hashed, so edges are never derived from it. Each slot ' +
    'kind that carries this contract adds its `slot:` prefix to the subjects in the index.',
});

/** An enumerated slot as the gate reads it, with its take when the caller already asked for it. */
interface Enumerated<F extends SolverFacts> {
  kind: SlotKind<F>;
  binding: unknown;
  held?: Held;
}

/** Answers the take a slot holds, from the rows its kind binds to it. */
function heldBy<F extends SolverFacts>(kind: SlotKind<F>, binding: unknown, facts: F): Held {
  const rows = newestFirst(kind.candidates(binding, facts));
  const take = pick(rows);
  return take ? { pick: take, rows } : { rows };
}

/**
 * Answers what each unit waits on. A gate naming an address the family does not enumerate holds
 * the unit, and each address is asked once.
 */
function gateUnits<F extends SolverFacts>(
  family: Family<F>,
  facts: F,
  enumerated: ReadonlyMap<string, Enumerated<F>>,
  units: Iterable<string>,
): Map<string, UnitGate> {
  const cleared = new Map<string, boolean>();
  const clears = (key: string): boolean => {
    let answer = cleared.get(key);
    if (answer === undefined) {
      const at = enumerated.get(key);
      if (!at) answer = false;
      else {
        const held = at.held ?? heldBy(at.kind, at.binding, facts);
        answer = at.kind.clears
          ? at.kind.clears(at.binding, facts, held)
          : at.kind.approved(at.binding, facts, held);
      }
      cleared.set(key, answer);
    }
    return answer;
  };

  const out = new Map<string, UnitGate>();
  for (const unit of units) {
    if (out.has(unit)) continue;
    const gates = [...new Set(family.gates(unit, facts))];
    const holding = gates.filter((key) => !clears(key));
    out.set(unit, { gates, holding, open: holding.length === 0 });
  }
  return out;
}

/**
 * Answers what each unit waits on, for every unit a slot names or the family owes, without
 * stating any slot's identity. A caller that only needs the gate, or needs it before it can
 * solve, asks here.
 */
export function unitGates<F extends SolverFacts>(
  family: Family<F>,
  facts: F,
): Map<string, UnitGate> {
  const enumerated = new Map<string, Enumerated<F>>();
  const units: string[] = [];
  for (const { kind, binding, unit } of family.enumerate(facts)) {
    const key = kind.key(binding);
    if (enumerated.has(key)) continue;
    enumerated.set(key, { kind, binding });
    if (unit !== undefined) units.push(unit);
  }
  units.push(...family.owed(facts));
  return gateUnits(family, facts, enumerated, units);
}

/** Lists a slot's drift: what its kind reports, then what its bound graph's fact says. */
function driftOf<F extends SolverFacts>(
  kind: SlotKind<F>,
  binding: unknown,
  key: string,
  facts: F,
): readonly DriftReason[] {
  const own = kind.drift?.(binding, facts) ?? [];
  const fact = facts.graphs?.get(key);
  const graph = fact === undefined ? undefined : boundDrift(fact);
  return graph === undefined ? own : [...own, graph];
}

/** Runs the family's slot kinds over every slot it enumerates. */
export function solve<F extends SolverFacts>(family: Family<F>, facts: F): Solution {
  const slots = new Map<string, SlotState>();
  const enumerated = new Map<string, Enumerated<F>>();
  const suspended = new Set(suspensions(family, facts).map((s) => s.hash));
  for (const { kind, binding, unit } of family.enumerate(facts)) {
    const key = kind.key(binding);
    if (slots.has(key)) continue;
    const held = heldBy(kind, binding, facts);
    const decided = kind.resolve(binding, facts);
    const hash = decided.ok ? taskHash(kind.task, decided.plan) : undefined;
    const status = hash === undefined ? undefined : facts.tasks.get(hash)?.status;
    enumerated.set(key, { kind, binding, held });

    slots.set(key, {
      key,
      kind: kind.prefix,
      task: kind.task,
      binding,
      label: kind.label(binding),
      ...(unit === undefined ? {} : { unit }),
      refs: kind.refs(binding, facts),
      ...(decided.ok ? { taskHash: hash, inputs: decided.plan } : { blocked: decided.reason }),
      deps: decided.ok ? (kind.deps?.(binding, facts) ?? []) : [],
      ...(status ? { status } : {}),
      ...(held.pick ? { pick: held.pick } : {}),
      candidates: held.rows.map((a) => a.hash),
      approved  : kind.approved(binding, facts, held),
      suspended : held.pick !== undefined && suspended.has(held.pick),
      drift     : driftOf(kind, binding, key, facts),
      ready     : false,
    });
  }

  const named: string[] = [];
  for (const state of slots.values()) if (state.unit !== undefined) named.push(state.unit);
  const units = gateUnits(family, facts, enumerated, [...named, ...family.owed(facts)]);
  const refusal = projectRefusal(facts);
  for (const state of slots.values()) {
    state.ready =
      refusal === undefined &&
      state.taskHash !== undefined &&
      (state.unit === undefined || units.get(state.unit)?.open === true);
  }

  const dependents = new Map<string, string[]>();
  for (const state of slots.values())
    for (const ref of state.refs) dependents.set(ref, [...(dependents.get(ref) ?? []), state.key]);

  // Post-order depth-first, so an upstream is emitted before everything drawn from it; `visiting`
  // stops a cycle a hand-edited project holds from wedging the walk
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const walk = (key: string): void => {
    if (done.has(key) || visiting.has(key)) return;
    visiting.add(key);
    for (const ref of slots.get(key)?.refs ?? []) walk(ref);
    visiting.delete(key);
    done.add(key);
    if (slots.has(key)) order.push(key);
  };
  for (const key of slots.keys()) walk(key);

  return { slots, dependents, order, units, ...(refusal === undefined ? {} : { refusal }) };
}
