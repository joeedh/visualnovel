/**
 * The generic loop: every slot a family enumerates, with the identity its kind can state for it
 * today, the reason it cannot, and the edges between slots inverted.
 *
 * A task hash covers the whole inputs object, and a downstream task's inputs embed its upstream's
 * output, so a downstream slot has no hash until its upstream has been drawn. Slots exist before
 * any of that, which is why the solver enumerates slots and attaches a hash only where it can.
 */
import type { TaskInputs, TaskKind, TaskStatus } from '@vn/types';
import { taskHash } from '@vn/taskgraph';
import type { Family, SolverFacts } from './family.js';

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
  /** The kind's sentence saying why no identity can be stated. */
  blocked?: string;
  status?: TaskStatus;
  /** The row the slot holds, where its kind is certain which. */
  pick?: string;
  /** Every manifest row bound here, in the kind's order. */
  candidates: readonly string[];
  approved: boolean;
}

/** Every slot, keyed by address, with its edges inverted and an upstream-first order. */
export interface Solution {
  slots: Map<string, SlotState>;
  /** Slot address → the slots drawn from it. */
  dependents: Map<string, string[]>;
  /** Upstream before downstream: the order approval has to happen in. */
  order: string[];
}

/** Runs the family's slot kinds over every slot it enumerates. */
export function solve<F extends SolverFacts>(family: Family<F>, facts: F): Solution {
  const slots = new Map<string, SlotState>();
  for (const { kind, binding, unit } of family.enumerate(facts)) {
    const key = kind.key(binding);
    if (slots.has(key)) continue;
    const rows = kind.candidates(binding, facts);
    const pick = kind.pick(binding, facts);
    const decided = kind.resolve(binding, facts);
    const hash = decided.ok ? taskHash(kind.task, decided.plan) : undefined;
    const status = hash === undefined ? undefined : facts.tasks.get(hash)?.status;

    slots.set(key, {
      key,
      kind: kind.prefix,
      task: kind.task,
      binding,
      label: kind.label(binding),
      ...(unit === undefined ? {} : { unit }),
      refs: kind.refs(binding, facts),
      ...(decided.ok ? { taskHash: hash, inputs: decided.plan } : { blocked: decided.reason }),
      ...(status ? { status } : {}),
      ...(pick ? { pick } : {}),
      candidates: rows.map((a) => a.hash),
      approved  : kind.approved(binding, facts, pick ? { pick, rows } : { rows }),
    });
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

  return { slots, dependents, order };
}
