/**
 * What a family hands the solver: its slot kinds, and the slots a project implies. The solver
 * reads only {@link SolverFacts}; everything else a family's facts carry passes through it to the
 * family's own functions unread.
 */
import type { AnyTask, Asset, TaskInputs, TaskKind } from '@vn/types';
import type { Contract } from '@vn/contracts';

/** A decision that either carries a plan or names, in a sentence, why there is none. */
export type Decided<T> = { ok: false; code: string; reason: string } | { ok: true; plan: T };

/** What the solver itself reads. A family's own facts extend it. */
export interface SolverFacts {
  /** The manifest, both roots. Absent means the caller holds no store. */
  readonly assets?: readonly Asset[];
  /** The latest record per task hash, so a dry run sees its own requeues. */
  readonly tasks: { get(hash: string): AnyTask | undefined };
}

/** The take a slot holds, as its kind reported it, which `approved` is decided from. */
export interface Held {
  /** The row the slot settles on, where the answer is certain. */
  readonly pick?: string;
  /** Every manifest row bound to the slot, in the kind's order. */
  readonly rows: readonly Asset[];
}

/**
 * One kind of slot a family declares. `B` is the binding a slot of this kind is addressed by, and
 * `K` the task kind that fills it, which types the inputs `resolve` answers.
 */
export interface SlotKind<F extends SolverFacts, B = unknown, K extends TaskKind = TaskKind> {
  /** Slot address prefix; never respelled, since authors and commands type it. */
  readonly prefix: string;
  /** Enters the task hash, so it never changes once shipped. */
  readonly task: K;
  /** Gives the slot's address, which is stable across re-plans. */
  key(binding: B): string;
  /** Reads an address back into a binding of this kind, or answers `undefined`. */
  parse(key: string): B | undefined;
  /** Names the slot in a sentence. */
  label(binding: B): string;
  /** Lists the addresses of the slots this one is drawn from, which may name no enumerated slot. */
  refs(binding: B, facts: F): readonly string[];
  /** Answers the task inputs this slot would run with, or the sentence saying why there are none. */
  resolve(binding: B, facts: F): Decided<TaskInputs[K]>;
  /** Lists every manifest row bound to the slot. */
  candidates(binding: B, facts: F): readonly Asset[];
  /** Answers the row the slot holds, or `undefined` when the answer is not certain. */
  pick(binding: B, facts: F): string | undefined;
  /** Says whether a person has approved what fills this slot. */
  approved(binding: B, facts: F, held: Held): boolean;
  /** Contracts that apply to every slot of this kind; the index adds `slot:<prefix>` to each. */
  readonly contracts?: readonly Contract[];
}

/** One slot a family enumerates: its kind, its binding, and the production unit it belongs to. */
export interface Slot<F extends SolverFacts> {
  readonly kind: SlotKind<F>;
  readonly binding: unknown;
  /** Opaque to the solver; a family groups slots by it. */
  readonly unit?: string;
}

/** Pairs a binding with its kind, so the pairing is checked where the family makes it. */
export function slot<F extends SolverFacts, B, K extends TaskKind>(
  kind: SlotKind<F, B, K>,
  binding: B,
  unit?: string,
): Slot<F> {
  return unit === undefined ? { kind, binding } : { kind, binding, unit };
}

/** A body of production code the solver runs its rules over. */
export interface Family<F extends SolverFacts> {
  readonly id: string;
  readonly kinds: readonly SlotKind<F>[];
  /** Lists every slot the project implies and is live, in the order the family wants them read. */
  enumerate(facts: F): Iterable<Slot<F>>;
}
