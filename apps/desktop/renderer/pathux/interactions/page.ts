/**
 * The Page editor's line drag, held as state: what a grab captures, what aiming it at a panel
 * makes of it, and the sentence the author reads meanwhile. The same shape as the coverage
 * strip's gestures: `targets` is judged once at the grab and every pointer move reads the answer
 * off by panel, so the drop commits `verdict.invoke` verbatim.
 */
import type { Verdict } from '@vn/commands';
import type { SceneCoverage } from '../../../src/shared/ipc.js';
import { letterId, pageLetter, panelTarget } from '../../../src/shared/interactions.js';
import { noticeForVerdict, type Notice } from '../../../src/shared/lineedit.js';
import { coverState } from './timeline.js';

/** Dragging one of a page's lines toward a panel: `page.letter`. */
export interface Letter {
  shotId: string;
  lineId: string;
  /** Every panel's verdict, judged once when the row was grabbed. Keyed by `panelTarget`. */
  verdicts: Map<string, Verdict>;
  /** The panel under the pointer, or `null` when it is over none. */
  panel: number | null;
  /** The verdict for that panel, `null` off the page. */
  verdict: Verdict | null;
}

/** The letter gesture, judged in full at the grab — the call `interaction.targets` makes in main. */
export function grabLine(data: SceneCoverage | null, shotId: string, lineId: string): Letter {
  const verdicts = pageLetter.targets(coverState(data), letterId(shotId, lineId));
  return {
    shotId,
    lineId,
    verdicts: new Map(verdicts.map((v) => [v.target, v])),
    panel   : null,
    verdict : null,
  };
}

/** The drag re-aimed at one panel, or at nothing. */
export function aimLine(letter: Letter, panel: number | null): Letter {
  if (panel === null) return { ...letter, panel: null, verdict: null };
  return { ...letter, panel, verdict: letter.verdicts.get(panelTarget(panel)) ?? null };
}

/** The verdict's own sentence, or `null` where the pointer is over no panel. */
export function letterNotice(letter: Letter): Notice | null {
  return letter.verdict ? noticeForVerdict(letter.verdict) : null;
}
