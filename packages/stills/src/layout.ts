/**
 * Page layouts: the panel templates an author or the decomposer starts from, the words a panel's
 * outline is described with in a prompt, and the overlap rule that matches the boxes a reviewer
 * saw to the panels a page intended.
 *
 * The words are derived from the outline rather than authored beside it, so the prompt and the
 * geometry cannot say two different things.
 */
import type { Defect, PagePanel, PanelBox } from '@vn/types';

export type PanelShape = PagePanel['shape'];

/** A rectangle as a clockwise outline from its top-left corner, in page fractions. */
export function rect(x: number, y: number, w: number, h: number): PanelShape {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/**
 * The named layouts. A decomposer names one instead of writing outlines, and an author picks one
 * to start from. Each is a page in reading order, and a template's panel count is fixed: a page
 * of some other count takes {@link evenLayout}.
 */
export const LAYOUT_TEMPLATES: Readonly<Record<string, readonly PanelShape[]>> = {
  'two-tier': [
    rect(0, 0, 0.5, 0.5),
    rect(0.5, 0, 0.5, 0.5),
    rect(0, 0.5, 0.5, 0.5),
    rect(0.5, 0.5, 0.5, 0.5),
  ],
  'three-tier': [
    rect(0, 0, 0.5, 1 / 3),
    rect(0.5, 0, 0.5, 1 / 3),
    rect(0, 1 / 3, 0.5, 1 / 3),
    rect(0.5, 1 / 3, 0.5, 1 / 3),
    rect(0, 2 / 3, 0.5, 1 / 3),
    rect(0.5, 2 / 3, 0.5, 1 / 3),
  ],
  'diagonal-split': [
    [
      [0, 0],
      [1, 0],
      [1, 0.35],
      [0, 0.65],
    ],
    [
      [0, 0.65],
      [1, 0.35],
      [1, 1],
      [0, 1],
    ],
  ],
  // A splash across the top three fifths over a row of two. The Stage 2 live check asked ten
  // models for a full-page splash with two insets floating over its lower corners, and every
  // one of them drew this instead, so this is the layout the name promises
  'splash-over-two': [rect(0, 0, 1, 0.6), rect(0, 0.6, 0.5, 0.4), rect(0.5, 0.6, 0.5, 0.4)],
};

/**
 * The layout a page of `n` panels takes when nothing chose one: tiers of two, reading left to
 * right, with an odd last panel spanning its tier. One panel is the whole page.
 */
export function evenLayout(n: number): PanelShape[] {
  const count = Math.max(1, Math.floor(n));
  const tiers = Math.ceil(count / 2);
  const height = 1 / tiers;
  const shapes: PanelShape[] = [];
  for (let i = 0; i < count; i++) {
    const tier = Math.floor(i / 2);
    const alone = i === count - 1 && count % 2 === 1;
    const x = i % 2 === 0 ? 0 : 0.5;
    shapes.push(rect(x, tier * height, alone ? 1 : 0.5, height));
  }
  return shapes;
}

/** The outlines a page of `n` panels takes under `layout`, or the even split when it names none. */
export function shapesFor(layout: string | undefined, n: number): PanelShape[] {
  const named = layout === undefined ? undefined : LAYOUT_TEMPLATES[layout];
  return named && named.length === n ? named.map((s) => s.map((p) => [...p])) : evenLayout(n);
}

/** The axis-aligned box around an outline. */
export function boxOf(shape: readonly (readonly [number, number])[]): PanelBox {
  const xs = shape.map((p) => p[0]);
  const ys = shape.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Within this much of a page edge counts as touching it. */
const EDGE = 0.02;

/** A slanted edge moves at least this far on both axes; anything less reads as a drawing wobble. */
const SLANT = 0.02;

/** A side is longer than the other by this factor before the panel reads as tall or wide. */
const OBLONG = 1.25;

/**
 * A panel's place on the page in words: its proportion, where it sits, and any edge that is
 * not straight — "tall, left column, full height, lower edge cut on a diagonal". Derived from
 * the outline alone, so the prompt's layout and the page's geometry cannot disagree.
 */
export function shapeWords(shape: PanelShape): string {
  const box = boxOf(shape);
  const left = box.x <= EDGE;
  const right = box.x + box.w >= 1 - EDGE;
  const top = box.y <= EDGE;
  const bottom = box.y + box.h >= 1 - EDGE;
  if (left && right && top && bottom) return withSlants('the full page', shape, box);

  const proportion =
    box.h > box.w * OBLONG ? 'tall' : box.w > box.h * OBLONG ? 'wide' : 'roughly square';
  const column = left && right ? 'full width' : left ? 'left' : right ? 'right' : 'centre';
  const row = top && bottom ? 'full height' : top ? 'top' : bottom ? 'bottom' : 'middle';

  let place: string;
  if (left && right) place = `${row} row, full width`;
  else if (top && bottom) place = `${column} column, full height`;
  else if (!left && !right && !top && !bottom) {
    // An inset touches no page edge, so it is placed by which quarter its centre falls in
    const lower = box.y + box.h / 2 > 0.5;
    const toRight = box.x + box.w / 2 > 0.5;
    place = `inset, ${lower ? 'lower' : 'upper'} ${toRight ? 'right' : 'left'}`;
  } else place = `${row}-${column}`;
  return withSlants(`${proportion}, ${place}`, shape, box);
}

/** `words` plus one clause per slanted side of the outline. */
function withSlants(words: string, shape: PanelShape, box: PanelBox): string {
  const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const sides = new Set<string>();
  for (let i = 0; i < shape.length; i++) {
    const a = shape[i]!;
    const b = shape[(i + 1) % shape.length]!;
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dx < SLANT || dy < SLANT) continue;
    const mid = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    // The slanted side is named by which way it faces from the panel's centre
    if (Math.abs(mid.y - centre.y) >= Math.abs(mid.x - centre.x)) {
      sides.add(mid.y > centre.y ? 'lower' : 'upper');
    } else {
      sides.add(mid.x > centre.x ? 'right' : 'left');
    }
  }
  const cuts = [...sides].map((side) => `${side} edge cut on a diagonal`);
  return [words, ...cuts].join(', ');
}

/** The whole page in words, one clause per panel, for the prompt's page sentence. */
export function layoutWords(panels: readonly Pick<PagePanel, 'shape'>[]): string {
  return panels.map((p, i) => `panel ${i + 1}: ${shapeWords(p.shape)}`).join('; ');
}

/** Intersection over union of two boxes; zero when they do not meet. */
export function iou(a: PanelBox, b: PanelBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const shared = w * h;
  const union = a.w * a.h + b.w * b.h - shared;
  return union <= 0 ? 0 : shared / union;
}

/**
 * How much of an intended panel an observed box must cover, as intersection over union, to
 * count as that panel. Half is where the Stage 2 live check put it: a drawn panel's median
 * overlap with its intended box is 0.65 to 0.95 depending on the template, a drawn gutter and
 * a reviewer's own imprecision take the rest, and the honoured rate falls away above 0.5
 * (`docs/research/manga-live-tests.md`).
 */
export const LAYOUT_IOU = 0.5;

/** Which observed box each intended panel matched, and the observed boxes no panel claimed. */
export interface PanelMatch {
  /** Per intended panel, the index of the observed box it matched, or `undefined`. */
  matched: (number | undefined)[];
  /** Observed boxes no intended panel matched. */
  extra: number[];
  /** Every intended panel matched a box and no box was left over. */
  honoured: boolean;
}

/**
 * Match the boxes a reviewer saw to the panels a page intended, each panel taking the best
 * unclaimed box at or above `threshold`, in reading order. The same rule files the `layout`
 * defect and scores the live check, so the two cannot disagree about what "honoured" means.
 */
export function matchPanels(
  intended: readonly Pick<PagePanel, 'shape'>[],
  observed: readonly PanelBox[],
  threshold = LAYOUT_IOU,
): PanelMatch {
  const claimed = new Set<number>();
  const matched = intended.map((panel) => {
    const box = boxOf(panel.shape);
    let best: { index: number; score: number } | undefined;
    observed.forEach((seen, index) => {
      if (claimed.has(index)) return;
      const score = iou(box, seen);
      if (score >= threshold && (best === undefined || score > best.score)) best = { index, score };
    });
    if (best === undefined) return undefined;
    claimed.add(best.index);
    return best.index;
  });
  const extra = observed.map((_, i) => i).filter((i) => !claimed.has(i));
  return { matched, extra, honoured: matched.every((m) => m !== undefined) && extra.length === 0 };
}

/**
 * The blocking defect a page earns when the boxes seen in it do not match its panels, or nothing
 * when they do. Says which panel went unmatched, in the same words the prompt used for it, so the
 * refinement that follows names the region rather than the whole page.
 */
export function layoutDefect(
  intended: readonly Pick<PagePanel, 'shape'>[],
  observed: readonly PanelBox[],
): Defect | undefined {
  const match = matchPanels(intended, observed);
  if (match.honoured) return undefined;
  const missing = match.matched
    .map((m, i) => (m === undefined ? `panel ${i + 1} (${shapeWords(intended[i]!.shape)})` : ''))
    .filter(Boolean);
  const parts = [
    observed.length !== intended.length
      ? `The page shows ${observed.length} panel(s) where ${intended.length} were intended.`
      : '',
    missing.length ? `No box in the page matches ${missing.join(', ')}.` : '',
  ].filter(Boolean);
  return {
    severity    : 'blocking',
    category    : 'layout',
    description : parts.join(' '),
    suggestedFix: `Draw exactly ${intended.length} panels with borders: ${layoutWords(intended)}.`,
  };
}
