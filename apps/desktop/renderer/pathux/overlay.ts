/**
 * The ring a tour points with, on a layer above the mesh that takes no pointer events.
 *
 * The layer owns its own `requestAnimationFrame` loop, because path.ux drives the screen off a
 * 150 ms interval in `screen/FrameManager.ts` and at that rate a ring visibly lags a scroll. Which
 * anchor a step means is re-asked on the slower beat; where that anchor is, every frame.
 *
 * Nothing here holds an {@link Anchor} across a frame — the registry is generation-scoped and a
 * reference kept over a redraw is a dangling pointer — so the loop keeps the key and asks again.
 */
import type { Anchor, AnchorRect } from '../rules/anchors.js';
import type { Guidance } from '../rules/tour.js';
import { RING_PAD, outset, ringRect } from '../rules/ring.js';
import { anchorFor, landsOn, rectOf } from './anchors.js';
import { TOKENS, alpha } from './tokens.js';

/** How often the step is re-resolved against what is drawn, against every frame for the rect. */
const RESOLVE_MS = 150;

/** Above every pane, the docker's own popups included. */
const LAYER_Z = 1_000_000;

let layer: HTMLElement | undefined;
let ring: HTMLElement | undefined;
let caption: HTMLElement | undefined;
const marks: HTMLElement[] = [];

let frame: number | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let ask: (() => Guidance | undefined) | undefined;
let beat = 0;
let key: string | undefined;
let also: readonly string[] = [];
let says = '';
const scrolled = new Set<string>();
const warned = new Set<string>();

/**
 * Follow a tour: ask it what to show on the slow beat, and keep the ring on whatever it named.
 * Replaces whatever was being followed.
 *
 * The loop runs on two clocks. A frame callback keeps the ring with a scroll, and Chromium
 * suspends frame callbacks altogether for an occluded window, so an interval drives the same
 * update at {@link RESOLVE_MS} — coarsely, which is enough for a window nobody is looking at.
 */
export function follow(resolve: () => Guidance | undefined): void {
  unfollow();
  ask = resolve;
  beat = 0;
  timer = setInterval(() => paint(performance.now()), RESOLVE_MS);
  frame = requestAnimationFrame(tick);
}

/** Stop following and take the ring off the screen. */
export function unfollow(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  if (timer !== undefined) clearInterval(timer);
  frame = undefined;
  timer = undefined;
  ask = undefined;
  key = undefined;
  also = [];
  says = '';
  scrolled.clear();
  warned.clear();
  hide();
}

/** What the overlay is ringing, for a test to read over CDP. */
export const ringing = (): string | undefined => (ring?.style.display === 'none' ? undefined : key);

function tick(now: number): void {
  frame = requestAnimationFrame(tick);
  paint(now);
}

/** One update: what the step means is re-asked on the slow beat, where the ring goes every time. */
function paint(now: number): void {
  if (now - beat >= RESOLVE_MS) {
    beat = now;
    reresolve();
  }
  const anchor = key === undefined ? undefined : anchorFor(key);
  if (anchor) place(anchor);
  else hide();
  mark();
}

/** Ask the tour again what the step means now, since a click may have moved everything under it. */
function reresolve(): void {
  const shown = ask?.();
  const target = shown && aimOf(shown);
  if (!target) {
    key = undefined;
    also = [];
    return;
  }
  key = target.anchor.key;
  also = target.also;
  says = target.say;
  if (target.offscreen) scrollTo(target.anchor);
}

/**
 * What a guidance points at, where it points at something drawn. A refusal is carried into the
 * caption, so a greyed control the tour rings says why it is greyed in the same breath.
 */
function aimOf(shown: Guidance): Aim | undefined {
  if (shown.show !== 'ring' && shown.show !== 'blocked') return undefined;
  const where = shown.where;
  if (!where || !('anchor' in where)) return undefined;
  const say = shown.show === 'blocked' ? `${shown.say} — but ${shown.reason}` : shown.say;
  const also = shown.show === 'ring' ? (shown.also ?? []) : [];
  return { anchor: where.anchor, say, also, offscreen: where.state === 'offscreen' };
}

interface Aim {
  anchor: Anchor;
  say: string;
  /** Keys to outline beside the ring — where a gesture could be dropped. */
  also: readonly string[];
  offscreen: boolean;
}

/**
 * Bring a scrolled-away target back into the window, once. Scrolling again on every beat would
 * fight the author for the scrollbar wherever the node has no scrollable ancestor to move.
 */
function scrollTo(anchor: Anchor): void {
  if (scrolled.has(anchor.key)) return;
  scrolled.add(anchor.key);
  const node = anchor.via.node;
  if (typeof Element !== 'undefined' && node instanceof Element) {
    node.scrollIntoView({ block: 'center', inline: 'center' });
  }
}

/** Put the ring where the anchor is now, widened to whatever a click there would actually hit. */
function place(anchor: Anchor): void {
  const box = rectOf(anchor);
  if (!box) return hide();
  const land = landsOn(anchor);
  if (!land.ok) miss(anchor);
  draw(outset(ringRect(box, land.ok ? land.hit : undefined), RING_PAD), anchor.enabled);
}

/**
 * A ring over something a click would not reach. A control clipped by a scroll container keeps a
 * rect inside the window, so the scroll is tried before anything is said about it.
 *
 * What is left after that is reported rather than resolved, once per control: the overlay cannot
 * tell a stacking fault from a control that has just moved, and a ring drawn at the right rect
 * over the wrong thing renders exactly like a correct one.
 */
function miss(anchor: Anchor): void {
  if (!scrolled.has(anchor.key)) return scrollTo(anchor);
  if (warned.has(anchor.key)) return;
  warned.add(anchor.key);
  console.warn(`tour: ${anchor.editor} ${anchor.key} is ringed, but a click there lands elsewhere`);
}

function draw(rect: AnchorRect, enabled: boolean): void {
  const [box, text] = build();
  const colour = enabled ? TOKENS.sodium : TOKENS.mistDim;
  Object.assign(box.style, {
    display: 'block',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderColor: colour,
    boxShadow: `0 0 0 3px ${alpha(colour, 0.25)}`,
  });
  text.textContent = says;
  // Below the ring where there is room for it, and above it otherwise, so a control near the
  // bottom of the window is still explained on screen
  const below = rect.bottom + 8;
  const room = below + 40 < window.innerHeight;
  Object.assign(text.style, {
    display: says ? 'block' : 'none',
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 320))}px`,
    top: room ? `${below}px` : '',
    bottom: room ? '' : `${window.innerHeight - rect.top + 8}px`,
  });
}

/**
 * Outline whatever else the step points at, more faintly than the ring: for a gesture, every
 * target that said it would take what is being carried.
 */
function mark(): void {
  for (let i = 0; i < Math.max(also.length, marks.length); i++) {
    const anchor = i < also.length ? anchorFor(also[i] ?? '') : undefined;
    const rect = anchor && rectOf(anchor);
    const box = marks[i] ?? newMark();
    if (!rect) {
      box.style.display = 'none';
      continue;
    }
    const at = outset(rect, RING_PAD);
    Object.assign(box.style, {
      display: 'block',
      left: `${at.left}px`,
      top: `${at.top}px`,
      width: `${at.width}px`,
      height: `${at.height}px`,
    });
  }
}

/** One more outline than the layer had. Kept and reused, since a gesture re-marks every beat. */
function newMark(): HTMLElement {
  build();
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    display: 'none',
    boxSizing: 'border-box',
    border: `1px dashed ${TOKENS.signal}`,
    borderRadius: `${TOKENS.radiusChrome}px`,
  });
  layer?.appendChild(box);
  marks.push(box);
  return box;
}

function hide(): void {
  if (ring) ring.style.display = 'none';
  if (!caption) return;
  caption.style.display = 'none';
  caption.textContent = '';
}

/** The layer, made on first use and kept, so a tour that starts and stops does not thrash the DOM. */
function build(): [HTMLElement, HTMLElement] {
  if (layer && ring && caption) return [ring, caption];
  layer = document.createElement('div');
  Object.assign(layer.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: `${LAYER_Z}`,
  });

  ring = document.createElement('div');
  Object.assign(ring.style, {
    position: 'fixed',
    display: 'none',
    boxSizing: 'border-box',
    border: `2px solid ${TOKENS.sodium}`,
    borderRadius: `${TOKENS.radiusChrome}px`,
    animation: 'vn-tour-pulse 1.6s ease-in-out infinite',
  });

  caption = document.createElement('div');
  Object.assign(caption.style, {
    position: 'fixed',
    display: 'none',
    maxWidth: '300px',
    padding: '7px 10px',
    borderRadius: `${TOKENS.radiusChrome}px`,
    border: `1px solid ${TOKENS.inkLine}`,
    background: TOKENS.inkRaised,
    color: TOKENS.paper,
    fontFamily: TOKENS.sans,
    fontSize: '12px',
    lineHeight: '1.4',
  });

  const style = document.createElement('style');
  style.textContent = `@keyframes vn-tour-pulse {
    0%, 100% { opacity: 1 }
    50% { opacity: 0.45 }
  }`;

  layer.append(style, ring, caption);
  document.body.appendChild(layer);
  return [ring, caption];
}
