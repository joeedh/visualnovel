/**
 * Reordering shots inside a scene by moving the lines they cover. {@link moveShot} hands back the
 * same {@link LineOp} the `lineops` decisions do, so a move takes their write path and undo entry.
 *
 * This module lives here rather than in `lineops.ts` because it has to read the storyboard, and
 * that module is pure over the scene set on purpose. It is the sibling of `shotfallout.ts`: that
 * one asks what a prose edit does to the shots, this one asks what a shot move does to the prose.
 */
import { contract } from '@vn/contracts';
import type { Scene, Shot } from '@vn/types';
import { nextIdOf, type LineOp, type ScriptState } from './lineops.js';

export const scriptShotOrderFromProse = contract({
  id      : 'script.shotOrderFromProse',
  rule: 'A shot has no position field: its place is where its covered lines sit. Moving a shot moves the block of lines it covers, through the scene write path, and only a contiguous shot can move; one with another shot drawing inside its lines is refused by name.',
  prevents:
    'A second ordering kept beside the prose that can disagree with it, and a move that silently interleaves shots or re-renders art.',
  subjects: [
    'module:packages/scriptedit/src/shotorder.ts',
    'function:packages/scriptedit/src/shotorder.ts#moveShot',
    'function:packages/scriptedit/src/shotorder.ts#planShotMove',
    'command:story.moveShot',
  ],
  see     : ['docs/plans/archive/INDEX.md#shot-ordering-in-scenes'],
  detail:
    "The exporter's `sceneBeats` emits a `show` beat whenever the covering shot changes down " +
    '`scene.lines`, so nothing needs renumbering. Coverage is a set and interleaving is normal (the ' +
    'deterministic decomposer gives the establishing shot every narration line while each medium ' +
    "shot takes one character's dialogue); a shot with holes is on screen in more than one place, " +
    'so it has no single position to move from. A move changes no hash: ids stay the same, coverage ' +
    "stays the same, and every shot's covered lines keep their relative order, so `proseHash`, which " +
    'walks `scene.lines` in order, does not drift and nothing re-renders.',
});

/** As much of a shot as a reorder reads. Both `Shot` and the app's `CoverageShot` satisfy it. */
export interface PositionedShot {
  id: string;
  coversLines: readonly string[];
}

/**
 * The decision: the scene's new line order, or the sentence that refuses it. `noop` marks the one
 * refusal a gesture should not show (the shot is already there) so a surface can drop that target
 * from its list instead of offering a drop the author would learn nothing from.
 */
export type ShotMove =
  { ok: true; message: string; order: string[] } | { ok: false; error: string; noop?: boolean };

/** Where a shot sits in a scene: its covered rows, as row indices the scene actually has. */
interface Extent {
  rows: number[];
  first: number;
  last: number;
}

/**
 * A shot's covered rows in scene order. Ids the scene no longer has are dropped rather than
 * positioned at a made-up row — the same thing `spansFor` and `readShots` do with a stale id.
 */
function extentOf(shot: PositionedShot, row: ReadonlyMap<string, number>): Extent | undefined {
  const rows = shot.coversLines
    .map((id) => row.get(id))
    .filter((i): i is number => i !== undefined)
    .sort((a, b) => a - b);
  const first = rows[0];
  const last = rows[rows.length - 1];
  return first === undefined || last === undefined ? undefined : { rows, first, last };
}

/** The shots drawing inside `extent`'s holes — what makes it unmovable, named so it can be fixed. */
function interleaving(
  shots: readonly PositionedShot[],
  moved: PositionedShot,
  extent: Extent,
  row: ReadonlyMap<string, number>,
): string[] {
  const own = new Set(extent.rows);
  const inside = (shot: PositionedShot): boolean =>
    shot.coversLines.some((id) => {
      const i = row.get(id);
      return i !== undefined && i > extent.first && i < extent.last && !own.has(i);
    });
  return shots.filter((s) => s.id !== moved.id && inside(s)).map((s) => s.id);
}

/**
 * The line order a scene would have with `shot` sitting immediately after `after`, or at the top
 * when `after` is empty. Decided over ids alone and kept separate from {@link moveShot} so the
 * timeline can judge a drag against the coverage strip it already holds and get the sentence the
 * command would give, without a `Scene` to hand.
 *
 * The target needs no contiguity of its own — only a last covered line to sit after. Uncovered
 * lines are left where they are: they belong to no shot, and a reorder is not a statement about
 * them.
 */
export function planShotMove(
  scene: { id: string; lineOrder: readonly string[] },
  shots: readonly PositionedShot[],
  args: { shot: string; after: string },
): ShotMove {
  const fail = (error: string): ShotMove => ({ ok: false, error });

  const moved = shots.find((s) => s.id === args.shot);
  if (!moved) return fail(`No shot "${args.shot}".`);
  if (args.after === args.shot) return fail('A shot cannot be moved after itself.');

  const order = scene.lineOrder;
  const row = new Map(order.map((id, i) => [id, i]));
  const extent = extentOf(moved, row);
  if (!extent) {
    return fail(`${moved.id} covers no line of ${scene.id}, so it has no position to move.`);
  }

  if (extent.last - extent.first + 1 !== extent.rows.length) {
    const others = interleaving(shots, moved, extent, row);
    const by = others.length ? ` ${others.join(', ')} draw(s) inside it.` : '';
    return fail(
      `${moved.id} covers ${extent.rows.length} line(s) with gaps between them, so it is on ` +
        `screen in more than one place and has no single position.${by} Give it the lines in ` +
        `between, or move lines one at a time.`,
    );
  }

  // Resolve the anchor to a line id first, so the splice can be computed against the order with
  // the block already lifted out. An empty target anchors at the top of the scene; otherwise the
  // anchor is the target's last covered line
  let anchor: string | undefined;
  if (args.after) {
    const target = shots.find((s) => s.id === args.after);
    if (!target) return fail(`No shot "${args.after}".`);
    const to = extentOf(target, row);
    if (!to) return fail(`${target.id} covers no line of ${scene.id}, so nothing can follow it.`);
    if (to.last >= extent.first && to.last <= extent.last) {
      return fail(`${target.id} and ${moved.id} both cover ${order[to.last]!}.`);
    }
    anchor = order[to.last]!;
  }

  const block = order.slice(extent.first, extent.last + 1);
  const rest = order.filter((_, i) => i < extent.first || i > extent.last);
  const at = anchor ? rest.indexOf(anchor) + 1 : 0;
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];

  if (next.every((id, i) => id === order[i])) {
    return {
      ok   : false,
      noop : true,
      error: anchor
        ? `${moved.id} already sits after ${args.after}.`
        : `${moved.id} is already first.`,
    };
  }

  const where = anchor ? `after ${args.after}` : `to the top of ${scene.id}`;
  return {
    ok     : true,
    order  : next,
    message:
      `Moved ${moved.id} ${where}, taking its ${block.length} line(s) with it. No shot's ` +
      `coverage or covered prose changed, so nothing drifts and nothing re-renders.`,
  };
}

/**
 * {@link planShotMove} as a scene edit. Curried over the shots so the decision keeps the
 * `(state) => LineOp` shape `planSceneEdit` takes: the caller reads `work/shots/<sceneId>.json` in
 * the same load as the script state, and nothing else about the write path changes.
 */
export function moveShot(
  shots: readonly Shot[],
  args: { shot: string; after: string },
): (state: ScriptState) => LineOp {
  return (state: ScriptState): LineOp => {
    const moved = shots.find((s) => s.id === args.shot);
    if (!moved) return { ok: false, error: `No shot "${args.shot}".` };

    const scene = state.scenes.get(moved.sceneId);
    if (!scene) return { ok: false, error: `No scene "${moved.sceneId}".` };

    const lineOrder = scene.lines.map((l) => l.id);
    const plan = planShotMove({ id: scene.id, lineOrder }, shots, args);
    if (!plan.ok) return { ok: false, error: plan.error };

    const byId = new Map(scene.lines.map((l) => [l.id, l]));
    const lines = plan.order.map((id) => byId.get(id)!);
    const writes: Scene[] = [{ ...scene, lines, nextLineId: nextIdOf(scene) }];
    return {
      ok     : true,
      message: plan.message,
      writes,
      removes  : [],
      retired  : [],
      moved    : [],
      retyped  : [],
      relocated: [],
    };
  };
}
