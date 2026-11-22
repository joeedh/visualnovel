/**
 * What a family hands the solver: its slot kinds, and the slots a project implies. The solver
 * reads only {@link SolverFacts}; everything else a family's facts carry passes through it to the
 * family's own functions unread.
 */
import type { AnyTask, Asset, BaseAssets, TaskInputs, TaskKind } from '@vn/types';
import type { Contract } from '@vn/contracts';
import type { BoundGraphFact, DriftReason } from './drift.js';
import type { DrawnFrom } from './suspend.js';

/** A decision that either carries a plan or names, in a sentence, why there is none. */
export type Decided<T> = { ok: false; code: string; reason: string } | { ok: true; plan: T };

/** What the solver itself reads. A family's own facts extend it. */
export interface SolverFacts {
  /** The manifest, both roots. Absent means the caller holds no store. */
  readonly assets?: readonly Asset[];
  /** The latest record per task hash, so a dry run sees its own requeues. */
  readonly tasks: { get(hash: string): AnyTask | undefined };
  /** The base asset root. An `unavailable` one refuses the project; absent means no opinion. */
  readonly base?: BaseAssets;
  /** The generation graph bound to each slot, by address. Absent means graph drift is not read. */
  readonly graphs?: ReadonlyMap<string, BoundGraphFact>;
}

/** The take a slot holds, by the solver's `pick`, which `approved` is decided from. */
export interface Held {
  /** The row the slot settles on, where the answer is certain. */
  readonly pick?: string;
  /** Every manifest row bound to the slot, newest first. */
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
  /**
   * Reads the inputs of a task that fills a slot of this kind back into the slot's binding, or
   * answers `undefined` when they name none. It reads none of the solver's fields, because a runner
   * asks with facts that hold no manifest and an empty task log.
   */
  fromInputs(inputs: Partial<TaskInputs[K]>, facts: F): B | undefined;
  /**
   * Task kinds no longer planned whose records still fill this slot. `taskSlot` matches a record of
   * one to this kind, and `fromInputs` reads its inputs.
   */
  readonly retired?: readonly string[];
  /**
   * Lists the task hashes the slot's task runs after, which become `Task.deps`. Only asked of a
   * slot that resolved; a kind without it runs after nothing.
   */
  deps?(binding: B, facts: F): readonly string[];
  /** Lists every manifest row bound to the slot, in manifest order. */
  candidates(binding: B, facts: F): readonly Asset[];
  /**
   * Lists the hashes the family's own records name as this slot's take. When the slot holds more
   * than one current row, the first of them that is current stays current.
   */
  named?(binding: B, facts: F): ReadonlySet<string>;
  /** Lists why the slot's picture is out of date by the family's own rules, beyond graph drift. */
  drift?(binding: B, facts: F): readonly DriftReason[];
  /** Says whether a person has approved what fills this slot. */
  approved(binding: B, facts: F, held: Held): boolean;
  /**
   * Says whether the slot lets a unit that waits on it go ahead. A kind without it answers with
   * `approved`; a kind whose gate reads approval its own way answers here.
   */
  clears?(binding: B, facts: F, held: Held): boolean;
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

/**
 * Answers the slot a task fills, through the first of the family's kinds whose `task` or `retired`
 * names the task's kind. The slot carries no unit, since a task does not record one.
 */
export function taskSlot<F extends SolverFacts>(
  family: Family<F>,
  task: Pick<AnyTask, 'kind' | 'inputs'>,
  facts: F,
): Slot<F> | undefined {
  const kind = family.kinds.find((k) => k.task === task.kind || k.retired?.includes(task.kind));
  const binding = kind?.fromInputs(task.inputs, facts);
  return kind && binding !== undefined ? { kind, binding } : undefined;
}

/** A body of production code the solver runs its rules over. */
export interface Family<F extends SolverFacts> {
  readonly id: string;
  readonly kinds: readonly SlotKind<F>[];
  /** Lists every slot the project implies and is live, in the order the family wants them read. */
  enumerate(facts: F): Iterable<Slot<F>>;
  /**
   * Lists every slot whose art a collection keeps. It is wider than `enumerate`, so art for slots
   * no plan has reached yet is not lost.
   */
  kept(facts: F): Iterable<Slot<F>>;
  /** Lists the live units that have no slots yet, because nothing has decomposed them. */
  owed(facts: F): readonly string[];
  /**
   * Lists the addresses of the slots a unit waits on. Until every one of them clears, the unit is
   * not decomposed and none of its slots is ready.
   */
  gates(unit: string, facts: F): readonly string[];
  /** Answers the slot a manifest row fills, or `undefined` for a row that fills none. */
  slotOf(row: Asset, facts: F): Slot<F> | undefined;
  /** Answers what a manifest row was drawn from, and which of its own references has moved. */
  drawnFrom(row: Asset, facts: F): DrawnFrom;
}
