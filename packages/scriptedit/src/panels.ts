/**
 * The rule about a page shot's panels: their outlines, what each frames, and which of the page's
 * lines each letters.
 *
 * It lives here for the reason the cast and outfit rules do: the desktop's `story.setPanels`, the
 * Page editor that previews it, and the agent's `set_panels` must give the same answer. Every part
 * of a panel is in the page's prompt, so any change re-hashes the shot and the next run draws the
 * page again. Moving a line between two panels of one page is this rule's, not `setCoverage`'s,
 * since the shot's own line set does not change.
 */
import { SHOT_FRAMINGS, type PagePanel, type Shot } from '@vn/types';
import type { ShotOutfitOp } from './outfits.js';

const listed = (ids: readonly string[]): string => ids.map((id) => `"${id}"`).join(', ');

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
 * Replace `shot`'s panels. An empty list makes the shot a single frame again; a list on a frame
 * makes it a page. Each panel's lines must be lines the page covers, and no line may be in two
 * panels; a covered line in no panel is allowed, and the message names it, because the page still
 * renders with that line unlettered. Lines are written in screenplay order.
 */
export function setPanels(
  shots: readonly Shot[],
  args: { shot: string; panels: readonly PagePanel[]; lineOrder: readonly string[] },
): ShotOutfitOp {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return { ok: false, error: `No shot "${args.shot}" in this scene.` };

  if (args.panels.length === 0) {
    if (!shot.panels)
      return { ok: false, error: `${args.shot} is already a single frame.`, noop: true };
    const { panels: _gone, ...frame } = shot;
    return {
      ok     : true,
      shots  : shots.map((s) => (s.id === args.shot ? frame : s)),
      message: `${args.shot} is a single frame now; its lines are no longer lettered. It is drawn again on the next run.`,
    };
  }

  const cast = new Set(shot.subjects.map((s) => s.characterId));
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
  const panels: PagePanel[] = args.panels.map((p) => ({
    ...p,
    coversLines: [...p.coversLines].sort(byRank),
  }));
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
