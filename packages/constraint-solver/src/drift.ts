/**
 * Drift: a slot whose picture no longer matches what would draw it now, although its task hash has
 * not moved. Drift from a bound generation graph is decided here, from {@link BoundGraphFact}; a
 * family reports its own kinds of drift through `SlotKind.drift`.
 */
import { contract } from '@vn/contracts';

export const graphsEditInvalidates = contract({
  id      : 'graphs.editInvalidates',
  rule: "Editing a generation graph bound to a slot moves no task hash, so it is reported as drift: the output node's authored hash differs from its last completed run's, or the node never ran and the graph is not the default one. `execution.redrawDrifted` redraws it.",
  prevents:
    'A `done` record keeping a picture the edited graph would no longer draw for the life of the project, or a slot redrawn on every run whether or not anyone edited its graph.',
  subjects: [
    'function:packages/constraint-solver/src/drift.ts#boundDrift',
    'function:packages/constraint-solver/src/solve.ts#solve',
    'function:packages/pipeline/src/graphrun.ts#graphFacts',
    'function:packages/pipeline/src/graphrun.ts#driftedTasks',
    'function:packages/gengraph/src/drift.ts#graphDrift',
    'function:packages/gengraph/src/drift.ts#isDefaultGraph',
  ],
  see: [
    'docs/reference/gen-graphs.md#identity-the-journal-and-drift',
    'docs/plans/node-based-asset-generation.md',
    'docs/plans/archive/contracts-into-code-and-workflows.md#stage-6-the-constraint-solver-with-stills-as-its-first-family',
  ],
  detail:
    "A bound graph runs the slot, and the graph is the slot's runner rather than part of what " +
    'the slot is, so editing it never moves the task hash; the difference shows as drift. ' +
    '`graphFacts` summarises each bound slot as a `BoundGraphFact`, and `boundDrift` decides it; ' +
    '`solve` reports it on `SlotState.drift` when the facts carry `graphs`, and `driftedTasks` ' +
    "answers the tasks whose slot has drifted. `graphDrift` recomputes each Output node's " +
    "authored hash and compares it against the journal's last `done` record for that node, for " +
    'the report, and `vngen status` lists what it reports: the edited arm alone, whatever the ' +
    'task. A graph bound to a slot the built-in runner already drew has no `done` record for its ' +
    'output, so `graphDrift` reports nothing for it, but the slot is still drifted unless ' +
    '`isDefaultGraph` finds the graph equivalent to `defaultSlotGraph` for the slot, which draws ' +
    'what the built-in runner drew. That comparison uses authored hashes, so a default graph ' +
    'whose nodes were only moved or joined by unconnected nodes still counts as the default. ' +
    'Drift is measured on `authoredHashes`, which reads each host-seeded input (the derived ' +
    "prompt, the task refs) as though nothing had been seeded onto it, and not on the task's " +
    'own `nodeHash`, which includes the seeding and would report drift after every run. ' +
    'Requeueing a drifted task, how a redraw clears the drift, and how `vngen cost` prices the ' +
    'redraw are `execution.redrawDrifted`. Editing prose is the opposite case; see ' +
    '`script.proseDriftReported`.',
});

/** One reason a slot's picture is out of date. */
export interface DriftReason {
  /** What moved: `graph` for a bound generation graph, or the name a family gives its own rule. */
  readonly source: string;
  /** The sentence a surface shows. */
  readonly reason: string;
}

/** What the generation graph bound to a slot says about the picture the slot holds. */
export interface BoundGraphFact {
  /** The output node that draws the slot. */
  readonly node: string;
  /** The node's authored hash in the graph as it stands. */
  readonly authored?: string;
  /** The authored hash the node's last completed run recorded, when that record carries one. */
  readonly recorded?: string;
  /** The node has a completed run on record. */
  readonly drawn: boolean;
  /** Asked only of a node with no completed run: the graph draws what the default graph draws. */
  readonly isDefault?: boolean;
}

const EDITED: DriftReason = {
  source: 'graph',
  reason: 'Its generation graph has been edited since it last drew this slot.',
};

const UNLIKE_DEFAULT: DriftReason = {
  source: 'graph',
  reason:
    'Its generation graph has not drawn this slot yet, and draws it differently from the default graph.',
};

/** Answers why a slot's bound graph would draw something other than the slot holds, if it would. */
export function boundDrift(fact: BoundGraphFact): DriftReason | undefined {
  if (!fact.drawn) return fact.isDefault === false ? UNLIKE_DEFAULT : undefined;
  const edited =
    fact.authored !== undefined && fact.recorded !== undefined && fact.authored !== fact.recorded;
  return edited ? EDITED : undefined;
}
