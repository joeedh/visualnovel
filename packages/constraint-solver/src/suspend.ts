/**
 * Suspension: what a moved upstream does to everything drawn from it. A row is suspended when one
 * of its own pinned references has moved, which its family says, or when a row it was drawn from
 * is suspended. Nothing is stored; the walk runs on every read, over the manifest in memory.
 */
import { contract } from '@vn/contracts';
import type { Family, SolverFacts } from './family.js';

export const takesSuspensionDerived = contract({
  id      : 'takes.suspensionDerived',
  rule: "A row is suspended when a pinned reference on it no longer names its slot's take, or when a row it was drawn from is suspended. `suspensions` derives that on every read and nothing stores it; a suspended row keeps its bytes and nothing is redrawn for it.",
  prevents:
    'A stored flag that every writer has to invalidate, which an interrupted cascade leaves disagreeing with the disk, or an upstream change that silently re-keys and redraws everything downstream of it.',
  subjects: [
    'function:packages/constraint-solver/src/suspend.ts#suspensions',
    'function:packages/constraint-solver/src/solve.ts#solve',
    'function:packages/stills/src/upstream.ts#attachedRefs',
    'command:asset.suspended',
    'command:prompt.repin',
    'command:asset.accept',
  ],
  see: [
    'docs/plans/archive/INDEX.md#chunked-prompts',
    'docs/plans/archive/contracts-into-code-and-workflows.md#stage-6-the-constraint-solver-with-stills-as-its-first-family',
  ],
  detail:
    'When a slot moves, everything pinned to its old hash is suspended, along with everything ' +
    "downstream of that. A row's upstream is what its task was drawn from (`Asset.refs`, so a row " +
    'that predates pinned references still cascades) plus the pins an author attached, and a ' +
    'muted clause contributes no pin. The walk carries a guard, so a reference cycle already on ' +
    'disk is stepped over rather than hanging it; refusing the cycle is the write-time check and ' +
    "the planner's. `suspensions` lists the suspended rows upstream first, the order an agent " +
    'clearing a subtree works in, and `asset.suspended` enumerates them in that order. ' +
    '`SlotState.suspended` says whether the take a slot holds is one of them. A suspended asset ' +
    'refuses `accept` and `approve` by name, and `prompt.repin` clears the suspension. ' +
    "`regenerate=false` re-approves: it swaps the pin, computes the newly keyed task's identity " +
    'from the state just written, and records the existing bytes as its output. Promotion rests ' +
    "on the same bound, that recorded work is never forged. A pinned reference's task hash does " +
    'not move when its slot moves, so the run plans nothing new for a suspended row until the ' +
    'author repins or regenerates.',
});

/** What a row was drawn from, as its family reads it. */
export interface DrawnFrom {
  /** The hashes the row was drawn from, in the order its task composed them. */
  readonly refs: readonly string[];
  /** The sentence naming the row's own reference that has moved, when one has. */
  readonly moved?: string;
}

/** One suspended row and why: the sentence a surface shows and an agent acts on. */
export interface Suspension {
  hash: string;
  reason: string;
  /** The suspended row this one inherited it from; absent when the move is its own. */
  via?: string;
}

const short = (hash: string): string => hash.slice(0, 8);

/**
 * Lists every suspended row in the manifest, upstream before downstream. A row whose own reference
 * moved is suspended for that reason alone, and its upstream is not walked on its account.
 */
export function suspensions<F extends SolverFacts>(family: Family<F>, facts: F): Suspension[] {
  const assets = facts.assets ?? [];
  const byHash = new Map(assets.map((a) => [a.hash, a]));
  const decided = new Map<string, Suspension | undefined>();
  const visiting = new Set<string>();
  const order: Suspension[] = [];

  const walk = (hash: string): Suspension | undefined => {
    if (decided.has(hash)) return decided.get(hash);
    if (visiting.has(hash)) return undefined;
    const row = byHash.get(hash);
    if (!row) return undefined;
    visiting.add(hash);

    const drawn = family.drawnFrom(row, facts);
    let found: Suspension | undefined =
      drawn.moved === undefined ? undefined : { hash, reason: drawn.moved };
    if (!found) {
      for (const up of drawn.refs) {
        if (!walk(up)) continue;
        found = { hash, reason: `it references ${short(up)}, which is suspended`, via: up };
        break;
      }
    }

    visiting.delete(hash);
    decided.set(hash, found);
    if (found) order.push(found);
    return found;
  };

  for (const row of assets) walk(row.hash);
  return order;
}
