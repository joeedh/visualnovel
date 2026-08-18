/**
 * The script column's one gesture: a line carried to another position in its own scene.
 *
 * Same contract as `branch.ts` and `timeline.ts` — `script.moveLine.targets` is pure and
 * synchronous, so the gesture is judged **once** at the grab and every pointer move reads the
 * answer off by insertion point. The sentence shown mid-drag, the drop that is allowed, and what
 * `interaction.targets` tells an agent are one verdict, and the commit is `verdict.invoke`
 * verbatim.
 *
 * Where the pointer *is* stays the surface's problem: `dropTarget` turns measured rows into an
 * insertion point, and this module takes that id. So the DOM read and the rule are separable, and
 * only the rule is tested here.
 *
 * This lived inside the React `ScriptEditor.tsx` and was never tested. It is pure, so here it is a
 * module with a `tests/` sibling like every other rule the shell runs.
 */
import { scriptMoveLine } from '../../src/shared/interactions.js';
import { noticeForVerdict, type Notice } from '../../src/shared/lineedit.js';
import { moveStateOf } from '../rules/script.js';
import type { MenuEntry } from './contextmenu.js';
import type { Invocation, Verdict } from '@vn/commands';
import type { CoverageShot, SceneCoverage } from '../../src/shared/ipc.js';

/** A line picked up by its gutter. */
export interface Drag {
  /** The line being carried. */
  line: string;
  /** Every insertion point's verdict, judged once on the grab. Keyed by `TOP` or a line id. */
  verdicts: ReadonlyMap<string, Verdict>;
  /** The insertion point under the pointer; `null` before the first move. */
  over: string | null;
  /** The verdict there, or `null` where the drop would reorder nothing. */
  verdict: Verdict | null;
}

/**
 * Pick a line up. Every insertion point is judged here, once — a drag that re-asked per pointer
 * move could change its mind about a drop the author is already over.
 */
export function grabLine(scene: SceneCoverage, line: string): Drag {
  const judged = scriptMoveLine.targets(moveStateOf(scene), line);
  return {
    line,
    verdicts: new Map(judged.map((v) => [v.target, v])),
    over: null,
    verdict: null,
  };
}

/**
 * The drag re-aimed at the insertion point now under the pointer. An insertion point `targets`
 * did not judge is a drop that would reorder nothing: no rule, and nothing to say.
 */
export function aim(drag: Drag, over: string | null): Drag {
  return { ...drag, over, verdict: over === null ? null : (drag.verdicts.get(over) ?? null) };
}

/** What a release commits: the verdict's own invocation, or nothing at all. */
export function dropOf(drag: Drag): Invocation | null {
  return drag.verdict?.accept ? drag.verdict.invoke : null;
}

/** Nothing to say where the drop is not a candidate; otherwise the verdict's own sentence. */
export function noticeOf(drag: Drag | null): Notice | null {
  return drag?.verdict ? noticeForVerdict(drag.verdict) : null;
}

/** The shot whose coverage includes this line, or `null`. A line is covered by at most one. */
export function shotCovering(shots: readonly CoverageShot[], lineId: string): CoverageShot | null {
  return shots.find((s) => s.coversLines.includes(lineId)) ?? null;
}

/**
 * What right-clicking a line offers. One entry today: the frame drawn from the shot that covers it.
 *
 * Both ways of having no picture are said rather than hidden — an author asking "where is the art
 * for this line?" is owed the answer, and "no shot covers it" and "its shot has not been drawn" are
 * different answers with different next moves. Neither is a question a command can be asked: there
 * is no hash to name, which is what {@link MenuEntry.refused} is for.
 */
export function lineMenu(scene: SceneCoverage, lineId: string): MenuEntry[] {
  const label = 'Open shot asset';
  const shot = shotCovering(scene.shots, lineId);
  if (!shot) {
    return [{ label, id: 'view.open', refused: `No shot covers ${lineId} yet.` }];
  }
  if (!shot.image) {
    return [
      { label, id: 'view.open', refused: `${shot.id} covers ${lineId} but has not been drawn.` },
    ];
  }
  const props = { editor: 'asset', where: 'elsewhere', subject: shot.image.hash };
  return [{ label, id: 'view.open', props }];
}
