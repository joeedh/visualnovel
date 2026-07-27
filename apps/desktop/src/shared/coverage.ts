/**
 * The pure half of `story.setCoverage`: which lines a shot is on screen for.
 *
 * It is in `shared/` for the same reason `branchops.ts` is — the timeline runs these functions
 * mid-drag to draw what a drop would produce, so the preview and the commit are the same rule
 * rather than two copies that can disagree.
 *
 * One invariant, and it is the whole point: **no line is covered by two shots.** The exporter
 * picks the first shot covering a line, so a doubly-covered line silently prefers whichever
 * shot happens to be first and the second shot's frame is never seen. Assigning a line to a
 * shot therefore takes it away from whatever held it before.
 *
 * Coverage is a *set*, not a range. The deterministic decomposer interleaves — the establishing
 * shot takes every narration line while each medium shot takes one character's dialogue — so
 * non-contiguous coverage is the normal case, not an edge case.
 */

/** Just enough of a `Shot` to reason about coverage. */
export interface CoverShot {
  id: string;
  coversLines: string[];
}

export type CoverageOp =
  | {
      ok: true;
      /** Every shot whose coverage changed, with its complete new line set. */
      changed: CoverShot[];
      /** Line ids no shot covers after the edit — a visible state, never an error. */
      uncovered: string[];
      message: string;
    }
  | { ok: false; error: string };

const refuse = (error: string): CoverageOp => ({ ok: false, error });

/**
 * Assign `lines` to `shot`, taking each of them off every other shot.
 *
 * `lineOrder` is the scene's line ids in screenplay order; it both validates the request (a
 * shot may not bind a line the scene does not have — the same rule `decomposeScene` applies to
 * an LLM's answer) and orders the result, so a file's `coversLines` always reads down the page.
 *
 * Lines the shot gives up are simply released. They become gaps, which the timeline draws as
 * uncovered — the one state this editor exists to reveal — rather than being quietly handed to
 * a neighbour the author did not name.
 *
 * Refuses a claim that would leave another shot covering nothing: releasing does not give lines
 * back, so a drag that swept over a neighbour and returned would destroy it. Revealing a shot
 * that covers nothing is this surface's job; manufacturing one is not.
 */
export function setCoverage(
  shots: readonly CoverShot[],
  args: { shot: string; lines: readonly string[]; lineOrder: readonly string[] },
): CoverageOp {
  const target = shots.find((s) => s.id === args.shot);
  if (!target) return refuse(`No shot "${args.shot}" in this scene.`);

  const rank = new Map(args.lineOrder.map((id, i) => [id, i]));
  const unknown = args.lines.filter((id) => !rank.has(id));
  if (unknown.length) {
    return refuse(`Scene has no line ${unknown.map((id) => `"${id}"`).join(', ')}.`);
  }

  const claimed = new Set(args.lines);
  const sorted = [...claimed].sort((a, b) => rank.get(a)! - rank.get(b)!);

  const next = shots.map((shot) =>
    shot.id === target.id
      ? { id: shot.id, coversLines: sorted }
      : { id: shot.id, coversLines: shot.coversLines.filter((id) => !claimed.has(id)) },
  );
  const before = new Map(shots.map((s) => [s.id, s.coversLines]));
  // The dragged shot leads, then the ones it took from in scene order — so a caller reading
  // `changed` sees the act before its consequences.
  const changed = next
    .filter((s) => !sameLines(before.get(s.id)!, s.coversLines))
    .sort((a, b) => Number(b.id === target.id) - Number(a.id === target.id));

  if (!changed.length) return refuse(`${target.id} already covers exactly those lines.`);

  // Emptying a *neighbour* is a deletion in disguise, and a drag sweeps across its neighbours on
  // the way to anywhere. Releasing does not give lines back, so dragging an edge over a shot and
  // returning would leave it real, paid for, and permanently undisplayable. The dragged shot may
  // still empty itself (`resolveDrag` never asks for that); this refuses only the side effect.
  const emptied = changed.filter(
    (s) => s.id !== target.id && s.coversLines.length === 0 && before.get(s.id)!.length > 0,
  );
  if (emptied.length) {
    return refuse(
      `That would leave ${emptied.map((s) => s.id).join(', ')} covering nothing. ` +
        `Move its coverage somewhere else first.`,
    );
  }
  const taken = changed
    .filter((s) => s.id !== target.id)
    .reduce((n, s) => n + before.get(s.id)!.length - s.coversLines.length, 0);

  const covered = new Set(next.flatMap((s) => s.coversLines));
  const uncovered = args.lineOrder.filter((id) => !covered.has(id));
  const from = taken > 0 ? `, taking ${taken} from ${changed.length - 1} other shot(s)` : '';
  return {
    ok: true,
    changed,
    uncovered,
    message: `${target.id} covers ${sorted.length} line(s)${from}.`,
  };
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);
