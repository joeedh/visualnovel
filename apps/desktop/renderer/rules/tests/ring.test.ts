import { centreOf, contains, outset, ringRect, union } from '../ring.js';
import type { AnchorRect } from '../anchors.js';

const rect = (left: number, top: number, width: number, height: number): AnchorRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
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
