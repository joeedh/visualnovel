/**
 * The coverage strip's three gestures, held as state rather than as markup: what a grab captures,
 * what aiming it at a row makes of it, and what the author is told meanwhile.
 *
 * All three follow the same shape, which is how the mid-gesture verdict contract is implemented.
 * `targets` is pure and synchronous, so the whole gesture is judged once at the grab and every
 * pointer move reads the answer off by row. The sentence shown mid-drag, the drop that is allowed,
 * and the one `interaction.targets` gives an agent are therefore one verdict, and the commit is
 * `verdict.invoke` verbatim.
 *
 * This lived inside the React `Timeline.tsx` and was never tested. It is pure, so here it is a
 * module with a `tests/` sibling like every other rule the shell runs.
 */
import { resolveDrag, type Edge } from '@vn/scriptedit';
import type { Coverage, ShotSpan } from '../../src/shared/ipc.js';
import {
  handleId,
  timelineCover,
  timelineCreate,
  timelineReorder,
  type CoverState,
} from '../../src/shared/interactions.js';
import { noticeForVerdict, type Notice } from '../../src/shared/lineedit.js';
import { shotDropTarget } from '../rules/timeline/coverage.js';
import type { Verdict } from '@vn/commands';
import type { SceneCoverage } from '../../src/shared/ipc.js';

/** Dragging a bracket's outer handle onto a line: `timeline.cover`. */
export interface Drag {
  shotId: string;
  edge: Edge;
  /** Every line's verdict, judged once when the handle was grabbed. Keyed by line id. */
  verdicts: Map<string, Verdict>;
  /** What the drop asks for; `null` when it changes nothing. Drawn even when refused. */
  lines: string[] | null;
  /** The verdict for the row under the pointer; `null` where the drop is not a candidate. */
  verdict: Verdict | null;
}

/** Dragging along the gutter to make a shot from the swept rows: `timeline.create`. */
export interface Create {
  /** The line the drag started on — one end of the swept range, wherever the pointer goes. */
  anchor: string;
  /** Every line's verdict, judged once when the gutter cell was grabbed. Keyed by line id. */
  verdicts: Map<string, Verdict>;
  /** The rows the drop would claim, for the ghost; `null` off the strip. */
  lines: string[] | null;
  /** The verdict for the row under the pointer. */
  verdict: Verdict | null;
}

/** The other gesture over the same brackets: dragging one bodily to another position. */
export interface Reorder {
  shotId: string;
  /** Every insertion point's verdict, judged once on the grab. Keyed by `TOP` or a shot id. */
  verdicts: Map<string, Verdict>;
  /** The insertion point under the pointer, and its verdict where it is a candidate. */
  target: string;
  verdict: Verdict | null;
}

/** `SceneCoverage` minus `decomposed`, which is the whole of what the timeline gestures judge. */
export function coverState(data: SceneCoverage | null): CoverState {
  return {
    sceneId: data?.sceneId ?? '',
    lines: data?.lines ?? [],
    shots: data?.shots ?? [],
    ...(data?.nextShot !== undefined ? { nextShot: data.nextShot } : {}),
  };
}

/**
 * The edge gesture, judged in full at the moment the handle is picked up — one call rather than
 * one per pointer move, and the same call `interaction.targets` makes in main.
 */
export function grabEdge(data: SceneCoverage | null, shotId: string, edge: Edge): Drag {
  const verdicts = timelineCover.targets(coverState(data), handleId(shotId, edge));
  return {
    shotId,
    edge,
    verdicts: new Map(verdicts.map((v) => [v.target, v])),
    lines: null,
    verdict: null,
  };
}

/**
 * The reorder, judged in full when the bracket is picked up. The shot starts aimed at itself,
 * which is not a target, so a click that never moves resolves to no verdict and commits nothing.
 * That is what lets one pointerdown serve as both "select this shot" and "start dragging it".
 */
export function grabShot(data: SceneCoverage | null, shotId: string): Reorder {
  const verdicts = timelineReorder.targets(coverState(data), shotId);
  return {
    shotId,
    verdicts: new Map(verdicts.map((v) => [v.target, v])),
    target: shotId,
    verdict: null,
  };
}

/**
 * The gutter gesture, judged in full when the cell is grabbed. The anchor row is itself a target,
 * so a drag that never leaves its row commits a one-line shot. That is a real act, unlike a
 * reorder dropped on itself.
 */
export function grabGutter(data: SceneCoverage | null, lineId: string): Create {
  const verdicts = timelineCreate.targets(coverState(data), lineId);
  return {
    anchor: lineId,
    verdicts: new Map(verdicts.map((v) => [v.target, v])),
    lines: null,
    verdict: null,
  };
}

/**
 * The edge drag re-aimed at one row. `resolveDrag` supplies the geometry the ghost needs, since a
 * verdict says whether and why rather than where. The verdict for that row supplies the rest.
 */
export function aimDrag(drag: Drag, coverage: Coverage, row: number): Drag {
  const lines = resolveDrag(coverage, drag.shotId, drag.edge, row);
  const verdict = drag.verdicts.get(coverage.rows[row]?.line.id ?? '');
  // A row `targets` did not judge is a row the drop would not change; there is nothing to draw.
  if (!lines || !verdict) return { ...drag, lines: null, verdict: null };
  return { ...drag, lines, verdict };
}

/**
 * The gutter drag re-aimed at one row. The swept range is anchor-to-row inclusive in row order,
 * which is the geometry the ghost draws. The verdict for the aimed row says what committing it
 * makes.
 */
export function aimCreate(create: Create, coverage: Coverage, row: number): Create {
  const aimed = coverage.rows[row]?.line.id;
  const verdict = aimed !== undefined ? (create.verdicts.get(aimed) ?? null) : null;
  if (!verdict) return { ...create, lines: null, verdict: null };
  const anchor = coverage.rows.findIndex((r) => r.line.id === create.anchor);
  const [first, last] = anchor <= row ? [anchor, row] : [row, anchor];
  const lines = coverage.rows.slice(first, last + 1).map((r) => r.line.id);
  return { ...create, lines, verdict };
}

/** The reorder re-aimed at one row, through the midpoint rule that names insertion points. */
export function aimReorder(reorder: Reorder, spans: readonly ShotSpan[], row: number): Reorder {
  const target = shotDropTarget(spans, row);
  // A shot dropped on itself is not a move and `targets` never listed it, so there is no verdict
  // and nothing is said. Reporting "that would change nothing" over its own rows is noise.
  const verdict = target === reorder.shotId ? null : (reorder.verdicts.get(target) ?? null);
  return { ...reorder, target, verdict };
}

/** The verdict's own sentence, or `null` where the drop is not a candidate. */
export function noticeOf(gesture: { verdict: Verdict | null }): Notice | null {
  return gesture.verdict ? noticeForVerdict(gesture.verdict) : null;
}
