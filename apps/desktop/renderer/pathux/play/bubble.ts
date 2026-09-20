/**
 * A speech bubble as the runner draws it: paper with the line in prose type at its anchor, and
 * a wedge to the tail point when the bubble has one. The Play pane draws one over the picture,
 * and the Page editor draws every placed bubble over the page it is editing, so the author sees
 * what the runner will show. Both position the layer; `fit` places the paper inside it.
 */
import type { PlayableBubble } from '../../../src/shared/ipc.js';
import { TOKENS, alpha } from '../app/tokens.js';

const SVG = 'http://www.w3.org/2000/svg';
/** How opaque a speech bubble's paper is over the page. */
const BUBBLE_PAPER = 0.92;
/** Half the width of a bubble tail where it leaves the bubble, in pixels. */
const TAIL_HALF_PX = 9;
/** The gap a bubble keeps from the picture's edge when its anchor would push it out, in pixels. */
const BUBBLE_MARGIN_PX = 6;

/** A bubble's placement: its anchor, and the point its tail reaches when it has one. */
export type BubbleSpot = Pick<PlayableBubble, 'anchor' | 'tail'>;

/** A drawn bubble: the layer to place over the picture, and the refit for the picture's size. */
export interface DrawnBubble {
  /** Absolutely positioned and inert to the pointer; the caller sets its box. */
  layer: HTMLElement;
  /**
   * Places the paper and the wedge for a picture `width` by `height` pixels. The bubble is kept
   * inside the picture even when its anchor sits at an edge, and its tail keeps its width
   * whatever the picture's aspect, which is why the geometry is in pixels rather than fractions.
   */
  fit(width: number, height: number): void;
}

/** How a bubble is drawn beyond its spot and its line. */
export interface BubbleLook {
  /** The speaker's display name, drawn above the line; absent draws none. */
  name?: string;
  /** Rings the paper, for the line being read among many. */
  outlined?: boolean;
}

/** Draws a line in its bubble. */
export function drawBubble(spot: BubbleSpot, text: string, look: BubbleLook = {}): DrawnBubble {
  const layer = document.createElement('div');
  Object.assign(layer.style, { position: 'absolute', pointerEvents: 'none', overflow: 'hidden' });

  const tail = document.createElementNS(SVG, 'svg');
  Object.assign(tail.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  const wedge = document.createElementNS(SVG, 'polygon');
  wedge.setAttribute('fill', alpha(TOKENS.paper, BUBBLE_PAPER));
  tail.appendChild(wedge);
  if (spot.tail) layer.appendChild(tail);

  const body = document.createElement('div');
  if (look.name !== undefined) {
    const who = document.createElement('div');
    who.textContent = look.name;
    Object.assign(who.style, {
      fontFamily   : TOKENS.disp,
      fontSize     : '11px',
      fontWeight   : '700',
      letterSpacing: '0.06em',
      marginBottom : '2px',
    });
    body.appendChild(who);
  }
  body.appendChild(document.createTextNode(text));
  Object.assign(body.style, {
    position    : 'absolute',
    maxWidth    : '44%',
    padding     : '8px 13px',
    background  : alpha(TOKENS.paper, BUBBLE_PAPER),
    color       : TOKENS.ink,
    fontFamily  : TOKENS.prose,
    fontSize    : '15px',
    lineHeight  : '1.35',
    textAlign   : 'center',
    borderRadius: spot.tail ? '16px' : '4px',
    boxShadow   : `0 1px 4px ${alpha(TOKENS.ink, 0.35)}`,
    ...(look.outlined ? { outline: `2px solid ${TOKENS.sodium}` } : {}),
  });
  layer.appendChild(body);

  const fit = (w: number, h: number): void => {
    const [ax, ay] = [spot.anchor[0] * w, spot.anchor[1] * h];
    const left = Math.min(
      Math.max(ax - body.offsetWidth / 2, BUBBLE_MARGIN_PX),
      w - body.offsetWidth - BUBBLE_MARGIN_PX,
    );
    const top = Math.min(
      Math.max(ay - body.offsetHeight / 2, BUBBLE_MARGIN_PX),
      h - body.offsetHeight - BUBBLE_MARGIN_PX,
    );
    Object.assign(body.style, { left: `${left}px`, top: `${top}px` });
    if (!spot.tail) return;
    // The wedge's base is centred on the bubble and hidden under it; only the point shows
    const [tx, ty] = [spot.tail[0] * w, spot.tail[1] * h];
    const [cx, cy] = [left + body.offsetWidth / 2, top + body.offsetHeight / 2];
    const len = Math.hypot(tx - cx, ty - cy) || 1;
    const [nx, ny] = [(-(ty - cy) / len) * TAIL_HALF_PX, ((tx - cx) / len) * TAIL_HALF_PX];
    tail.setAttribute('viewBox', `0 0 ${w} ${h}`);
    wedge.setAttribute('points', `${cx + nx},${cy + ny} ${cx - nx},${cy - ny} ${tx},${ty}`);
  };
  return { layer, fit };
}
