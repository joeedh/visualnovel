/**
 * The rule about a page shot's panels: their outlines, what each frames, and which of the page's
 * lines each letters.
 *
 * It lives here for the reason the cast and outfit rules do: the desktop's `story.setPanels`, the
 * Page editor that previews it, and the agent's `set_panels` must give the same answer. Every part
 * of a panel is in the page's prompt, so any change re-hashes the shot and the next run draws the
 * page again. Moving a line between two panels of one page is this rule's, not `setCoverage`'s,
 * since the shot's own line set does not change. Bubbles are the one part of a panel this rule
 * does not take: they are `setBubbles`'s, and a restatement carries the page's own through.
 */
import { SHOT_FRAMINGS, type PagePanel, type PanelBubble } from '@vn/types';
import { filed } from './bubbles.js';

/**
 * Just enough of a `Shot` to reason about its panels. `subjects` may be character ids or the
 * storyboard's subject records, because the desktop's coverage read carries the former and the
 * storyboard on disk the latter, and both hosts judge the same edit.
 */
export interface PanelShot {
  id: string;
  coversLines: string[];
  subjects: readonly (string | { characterId: string })[];
  panels?: PagePanel[];
}

/** A panel change: the scene's shots as they would be written, the edited one among them. */
export type PanelsOp<S extends PanelShot> =
  { ok: true; shots: S[]; message: string } | { ok: false; error: string; noop?: boolean };

const listed = (ids: readonly string[]): string => ids.map((id) => `"${id}"`).join(', ');

const castOf = (shot: PanelShot): Set<string> =>
  new Set(shot.subjects.map((s) => (typeof s === 'string' ? s : s.characterId)));

/** Why one panel cannot stand, or `undefined` when it can. */
function panelFault(
  panel: PagePanel,
  index: number,
  cast: ReadonlySet<string>,
): string | undefined {
  const at = `Panel ${index + 1}`;
  if (panel.shape.length < 3) return `${at} needs at least three corners.`;
  for (const [x, y] of panel.shape) {
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
      return `${at} has a corner off the page (${x}, ${y}); corners are page fractions from 0 to 1.`;
    }
  }
  if (!SHOT_FRAMINGS.includes(panel.framing)) {
    return `${at} has no framing "${String(panel.framing)}"; one of ${listed(SHOT_FRAMINGS)}.`;
  }
  const strangers = panel.subjects.map((s) => s.characterId).filter((id) => !cast.has(id));
  if (strangers.length > 0) {
    return `${at} casts ${listed(strangers)}, who the page does not frame. Add them to the shot's cast first.`;
  }
  return undefined;
}

/**
 * The bubbles that survive a restatement: a line's bubble was placed against the panel that
 * lettered it, so it stays only while the line stays in the panel at that index, and a page made
 * a frame keeps none. Any `bubbles` on the incoming panels are ignored; `setBubbles` is their
 * write path.
 */
function carried(
  before: readonly PagePanel[] | undefined,
  after: readonly PagePanel[],
): PanelBubble[] {
  return after.flatMap((panel, i) => {
    const old = before?.[i];
    if (!old) return [];
    return (old.bubbles ?? []).filter((b) => panel.coversLines.includes(b.lineId));
  });
}

/**
 * Replace `shot`'s panels. An empty list makes the shot a single frame again; a list on a frame
 * makes it a page. Each panel's lines must be lines the page covers, and no line may be in two
 * panels; a covered line in no panel is allowed, and the message names it, because the page still
 * renders with that line unlettered. Lines are written in screenplay order.
 */
export function setPanels<S extends PanelShot>(
  shots: readonly S[],
  args: { shot: string; panels: readonly PagePanel[]; lineOrder: readonly string[] },
): PanelsOp<S> {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return { ok: false, error: `No shot "${args.shot}" in this scene.` };

  if (args.panels.length === 0) {
    if (!shot.panels)
      return { ok: false, error: `${args.shot} is already a single frame.`, noop: true };
    const { panels: _gone, ...frame } = shot;
    return {
      ok     : true,
      shots  : shots.map((s) => (s.id === args.shot ? (frame as S) : s)),
      message: `${args.shot} is a single frame now; its lines are no longer lettered. It is drawn again on the next run.`,
    };
  }

  const cast = castOf(shot);
  for (const [i, panel] of args.panels.entries()) {
    const fault = panelFault(panel, i, cast);
    if (fault) return { ok: false, error: fault };
  }

  const covered = new Set(shot.coversLines);
  const rank = new Map(args.lineOrder.map((id, i) => [id, i]));
  const seen = new Map<string, number>();
  for (const [i, panel] of args.panels.entries()) {
    for (const id of panel.coversLines) {
      if (!covered.has(id)) {
        return {
          ok   : false,
          error: `Panel ${i + 1} letters ${id}, which ${args.shot} does not cover.`,
        };
      }
      const other = seen.get(id);
      if (other !== undefined) {
        return {
          ok   : false,
          error: `${id} is in panel ${other + 1} and panel ${i + 1}; a line is lettered once.`,
        };
      }
      seen.set(id, i);
    }
  }

  const byRank = (a: string, b: string): number => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  const restated: PagePanel[] = args.panels.map((p) => ({
    ...p,
    coversLines: [...p.coversLines].sort(byRank),
  }));
  const panels = filed(restated, carried(shot.panels, restated));
  if (shot.panels && JSON.stringify(shot.panels) === JSON.stringify(panels)) {
    return { ok: false, error: `${args.shot} already has exactly those panels.`, noop: true };
  }

  const unlettered = shot.coversLines.filter((id) => !seen.has(id));
  const became = shot.panels ? '' : ` ${args.shot} is a page now.`;
  const gaps = unlettered.length
    ? ` ${unlettered.join(', ')} ${unlettered.length === 1 ? 'is' : 'are'} in no panel and will not be lettered.`
    : '';
  return {
    ok     : true,
    shots  : shots.map((s) => (s.id === args.shot ? { ...s, panels } : s)),
    message: `${args.shot} has ${panels.length} panel(s).${became}${gaps} The page is drawn again on the next run.`,
  };
}

/**
 * The panel list with `line` lettered in panel `index` and in no other. The list a drop on the
 * Page editor, or the agent, hands to {@link setPanels}; the rule then says whether it stands.
 */
export function letterLine(panels: readonly PagePanel[], index: number, line: string): PagePanel[] {
  return panels.map((panel, i) => {
    const kept = panel.coversLines.filter((id) => id !== line);
    return { ...panel, coversLines: i === index ? [...kept, line] : kept };
  });
}
