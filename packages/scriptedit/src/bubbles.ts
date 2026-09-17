/**
 * The rule about a page shot's speech bubbles: where the runner draws each lettered line under
 * `lettering: runner`.
 *
 * It lives beside the panel rule for the same reason: the desktop's `story.setBubbles`, the Page
 * editor that previews it, and the agent's `set_bubbles` must give the same answer. A bubble is
 * authored on the panel that letters its line and is read by no prompt builder, so placing one
 * re-renders nothing; that is why it is a rule of its own rather than a case of `setPanels`,
 * whose every write is a redraw.
 */
import type { PagePanel, PanelBubble } from '@vn/types';

/** Just enough of a `Shot` to reason about its bubbles. */
export interface BubbleShot {
  id: string;
  coversLines: string[];
  panels?: PagePanel[];
}

/** A bubble change: the scene's shots as they would be written, the edited one among them. */
export type BubblesOp<S extends BubbleShot> =
  { ok: true; shots: S[]; message: string } | { ok: false; error: string; noop?: boolean };

const onPage = ([x, y]: readonly [number, number]): boolean => x >= 0 && x <= 1 && y >= 0 && y <= 1;

/** Every bubble a page holds, in panel order, as the whole list a restatement starts from. */
export function bubblesOf(panels: readonly PagePanel[]): PanelBubble[] {
  return panels.flatMap((p) => p.bubbles ?? []);
}

/** The panel index lettering `line`, or -1. */
const panelOf = (panels: readonly PagePanel[], line: string): number =>
  panels.findIndex((p) => p.coversLines.includes(line));

/**
 * `panels` with each bubble in the panel that letters its line, in that panel's line order, and
 * `bubbles` left off a panel with none. The shape the file is written in, so an unchanged
 * restatement compares equal.
 */
export function filed(panels: readonly PagePanel[], bubbles: readonly PanelBubble[]): PagePanel[] {
  return panels.map((panel) => {
    const { bubbles: _old, ...rest } = panel;
    const own = panel.coversLines.flatMap((id) => bubbles.filter((b) => b.lineId === id));
    return own.length ? { ...rest, bubbles: own } : rest;
  });
}

/**
 * Restate `shot`'s bubbles. Refused on a frame, for a line no panel letters, for a line named
 * twice, and for a point off the page; a no-op when the page already says exactly that. The
 * message counts what is placed and what still reads in the dialogue box, and says nothing about
 * rendering, because nothing renders.
 */
export function setBubbles<S extends BubbleShot>(
  shots: readonly S[],
  args: { shot: string; bubbles: readonly PanelBubble[] },
): BubblesOp<S> {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return { ok: false, error: `No shot "${args.shot}" in this scene.` };
  if (!shot.panels) {
    return {
      ok   : false,
      error: `${args.shot} is a single frame; a bubble sits on a page's panel. Make it a page first.`,
    };
  }

  const seen = new Set<string>();
  for (const bubble of args.bubbles) {
    if (panelOf(shot.panels, bubble.lineId) < 0) {
      return {
        ok   : false,
        error: `${bubble.lineId} is in no panel of ${args.shot}; a bubble goes on a lettered line.`,
      };
    }
    if (seen.has(bubble.lineId)) {
      return { ok: false, error: `${bubble.lineId} is named twice; a line has one bubble.` };
    }
    seen.add(bubble.lineId);
    if (!onPage(bubble.anchor) || (bubble.tail && !onPage(bubble.tail))) {
      return {
        ok   : false,
        error: `${bubble.lineId}'s bubble is off the page; points are page fractions from 0 to 1.`,
      };
    }
  }

  const panels = filed(shot.panels, args.bubbles);
  if (JSON.stringify(shot.panels) === JSON.stringify(panels)) {
    return { ok: false, error: `${args.shot} already has exactly those bubbles.`, noop: true };
  }
  const lettered = shot.panels.flatMap((p) => p.coversLines).length;
  const boxed = lettered - seen.size;
  const rest = boxed ? ` ${boxed} lettered line(s) still read in the dialogue box.` : '';
  return {
    ok     : true,
    shots  : shots.map((s) => (s.id === args.shot ? { ...s, panels } : s)),
    message: `${args.shot} has ${seen.size} bubble(s) placed.${rest} Nothing is drawn again.`,
  };
}

/** The bubble list with `line`'s bubble at `anchor`, keeping its tail when it had one. */
export function placeBubble(
  bubbles: readonly PanelBubble[],
  line: string,
  anchor: [number, number],
): PanelBubble[] {
  const had = bubbles.find((b) => b.lineId === line);
  const placed: PanelBubble = { lineId: line, anchor, ...(had?.tail ? { tail: had.tail } : {}) };
  return [...bubbles.filter((b) => b.lineId !== line), placed];
}

/** The bubble list with `line`'s tail at `tail`, or with no tail when `tail` is `undefined`. */
export function aimBubble(
  bubbles: readonly PanelBubble[],
  line: string,
  tail: [number, number] | undefined,
): PanelBubble[] {
  return bubbles.map((b) => {
    if (b.lineId !== line) return b;
    const { tail: _old, ...rest } = b;
    return tail ? { ...rest, tail } : rest;
  });
}

/** The bubble list without `line`'s bubble. */
export function removeBubble(bubbles: readonly PanelBubble[], line: string): PanelBubble[] {
  return bubbles.filter((b) => b.lineId !== line);
}
