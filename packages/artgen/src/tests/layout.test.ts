/**
 * Page layouts: the templates, the words an outline is described with, and the overlap rule
 * that decides whether a drawn page honoured its panels.
 */
import {
  LAYOUT_TEMPLATES,
  boxOf,
  evenLayout,
  iou,
  layoutDefect,
  layoutWords,
  matchPanels,
  rect,
  shapeWords,
  shapesFor,
} from '../layout.js';

describe('the templates and the even split', () => {
  it('lay every panel inside the unit page, clockwise from the top-left', () => {
    for (const [name, shapes] of Object.entries(LAYOUT_TEMPLATES)) {
      for (const shape of shapes) {
        expect(shape.length).toBeGreaterThanOrEqual(3);
        for (const [x, y] of shape) {
          expect({ name, x, y }).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('splits n panels into tiers of two, the odd last one spanning its tier', () => {
    expect(evenLayout(1)).toEqual([rect(0, 0, 1, 1)]);
    expect(evenLayout(3)).toEqual([
      rect(0, 0, 0.5, 0.5),
      rect(0.5, 0, 0.5, 0.5),
      rect(0, 0.5, 1, 0.5),
    ]);
    expect(evenLayout(6)).toHaveLength(6);
    expect(evenLayout(6)[5]).toEqual(rect(0.5, 2 / 3, 0.5, 1 / 3));
    expect(boxOf(evenLayout(6)[5]!)).toMatchObject({ x: 0.5, w: 0.5 });
  });

  it('takes a named template only at its own panel count, and the even split otherwise', () => {
    expect(shapesFor('two-tier', 4)).toEqual(LAYOUT_TEMPLATES['two-tier']);
    expect(shapesFor('two-tier', 3)).toEqual(evenLayout(3));
    expect(shapesFor('no-such-layout', 2)).toEqual(evenLayout(2));
    // A copy, so a caller that edits a panel's outline does not edit the template.
    expect(shapesFor('two-tier', 4)[0]).not.toBe(LAYOUT_TEMPLATES['two-tier']![0]);
  });
});

describe('shapeWords', () => {
  it('names the proportion, the place and any slanted edge', () => {
    expect(shapeWords(rect(0, 0, 1, 1))).toBe('the full page');
    expect(shapeWords(rect(0, 0, 0.5, 0.5))).toBe('roughly square, top-left');
    expect(shapeWords(rect(0, 0, 1, 1 / 3))).toBe('wide, top row, full width');
    expect(shapeWords(rect(0, 0, 0.3, 1))).toBe('tall, left column, full height');
    expect(shapeWords(rect(0.6, 0.65, 0.35, 0.3))).toBe('roughly square, inset, lower right');
    expect(shapeWords(LAYOUT_TEMPLATES['diagonal-split']![0]!)).toBe(
      'wide, top row, full width, lower edge cut on a diagonal',
    );
    expect(shapeWords(LAYOUT_TEMPLATES['diagonal-split']![1]!)).toBe(
      'wide, bottom row, full width, upper edge cut on a diagonal',
    );
  });

  it('describes the splash template as a top row over two, which is what models draw', () => {
    expect(layoutWords(LAYOUT_TEMPLATES['splash-over-two']!.map((shape) => ({ shape })))).toBe(
      'panel 1: wide, top row, full width; panel 2: roughly square, bottom-left; ' +
        'panel 3: roughly square, bottom-right',
    );
  });

  it('numbers the panels in reading order for the page sentence', () => {
    expect(layoutWords(LAYOUT_TEMPLATES['two-tier']!.map((shape) => ({ shape })))).toBe(
      'panel 1: roughly square, top-left; panel 2: roughly square, top-right; ' +
        'panel 3: roughly square, bottom-left; panel 4: roughly square, bottom-right',
    );
  });
});

describe('matching observed boxes to intended panels', () => {
  const tiers = LAYOUT_TEMPLATES['two-tier']!.map((shape) => ({ shape }));

  it('scores overlap as intersection over union', () => {
    expect(iou({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 1, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 })).toBe(0.5);
    expect(iou({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 })).toBe(0);
  });

  it('honours a page whose boxes sit near enough to every panel, in any order', () => {
    const seen = [
      { x: 0.52, y: 0.02, w: 0.46, h: 0.46 },
      { x: 0.02, y: 0.02, w: 0.46, h: 0.46 },
      { x: 0.02, y: 0.52, w: 0.46, h: 0.46 },
      { x: 0.52, y: 0.52, w: 0.46, h: 0.46 },
    ];
    expect(matchPanels(tiers, seen)).toEqual({
      matched : [1, 0, 2, 3],
      extra   : [],
      honoured: true,
    });
    expect(layoutDefect(tiers, seen)).toBeUndefined();
  });

  it('files a blocking layout defect naming the count and the unmatched panel', () => {
    // One wide box where two panels were meant: it covers each of them under half
    const seen = [
      { x: 0, y: 0, w: 1, h: 0.6 },
      { x: 0, y: 0.6, w: 0.5, h: 0.4 },
      { x: 0.5, y: 0.6, w: 0.5, h: 0.4 },
    ];
    const defect = layoutDefect(tiers, seen);
    expect(defect).toMatchObject({ severity: 'blocking', category: 'layout' });
    expect(defect?.description).toBe(
      'The page shows 3 panel(s) where 4 were intended. No box in the page matches ' +
        'panel 1 (roughly square, top-left), panel 2 (roughly square, top-right).',
    );
    expect(defect?.suggestedFix).toContain('Draw exactly 4 panels with borders: panel 1:');
  });

  it('counts a box no panel claims against the page, even at the right count', () => {
    const seen = [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    ];
    const match = matchPanels(tiers, seen);
    expect(match.honoured).toBe(false);
    expect(match.extra).toEqual([3]);
  });
});
