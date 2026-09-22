import { captionAt, centreOf, contains, outset, ringRect, union } from '../ring.js';
import type { AnchorRect } from '../anchors.js';

const rect = (left: number, top: number, width: number, height: number): AnchorRect => ({
  left,
  top,
  width,
  height,
  right : left + width,
  bottom: top + height,
});

describe('ring geometry', () => {
  it('takes the centre of a box', () => {
    expect(centreOf(rect(10, 20, 40, 10))).toEqual({ x: 30, y: 25 });
  });

  it('reads a box as containing itself', () => {
    const box = rect(0, 0, 10, 10);
    expect(contains(box, box)).toBe(true);
  });

  it('does not read a box as containing one that pokes out of it', () => {
    expect(contains(rect(0, 0, 10, 10), rect(-1, 0, 4, 4))).toBe(false);
  });

  it('covers both rects in a union', () => {
    expect(union(rect(0, 0, 10, 10), rect(20, -5, 10, 10))).toEqual(rect(0, -5, 30, 15));
  });

  it('grows a rect on every side', () => {
    expect(outset(rect(10, 10, 6, 6), 4)).toEqual(rect(6, 6, 14, 14));
  });
});

describe('ringRect', () => {
  const box = rect(100, 100, 20, 20);

  it('rings the box where nothing was measured', () => {
    expect(ringRect(box)).toBe(box);
  });

  it('rings the box where the hit sits inside it', () => {
    expect(ringRect(box, rect(104, 104, 12, 12))).toBe(box);
  });

  it('widens to a hit that reaches the anchor from outside its box', () => {
    expect(ringRect(box, rect(95, 100, 30, 20))).toEqual(rect(95, 100, 30, 20));
  });
});

describe('captionAt', () => {
  const view = { width: 1000, height: 800 };
  const caption = { width: 300, height: 60 };

  it('puts the caption under the ring it explains', () => {
    const at = captionAt(rect(100, 100, 40, 20), caption, view);
    expect(at).toEqual({ left: 100, top: 128, nudge: { dx: 0, dy: 0 } });
  });

  it('puts it over the ring where the window has no room below', () => {
    const at = captionAt(rect(100, 720, 40, 20), caption, view);
    expect(at.top).toBe(652);
  });

  it('moves it by what the author dragged', () => {
    const at = captionAt(rect(100, 100, 40, 20), caption, view, { dx: 60, dy: -30 });
    expect(at).toEqual({ left: 160, top: 98, nudge: { dx: 60, dy: -30 } });
  });

  it('keeps a dragged caption inside the window', () => {
    const at = captionAt(rect(100, 100, 40, 20), caption, view, { dx: 5000, dy: 5000 });
    expect(at.left).toBe(692);
    expect(at.top).toBe(732);
  });

  it('reports the offset it granted rather than the one it was asked for', () => {
    const at = captionAt(rect(900, 100, 40, 20), caption, view);
    expect(at.left).toBe(692);
    expect(at.nudge).toEqual({ dx: -208, dy: 0 });
  });
});
