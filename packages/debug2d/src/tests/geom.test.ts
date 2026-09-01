/**
 * Covers where `containsPoint` and `boxHitsPoint` diverge, which is only the far edges.
 * `containsPoint` answers a range question and `boxHitsPoint` answers where a click lands, so
 * swapping one for the other breaks nothing an interior point would catch.
 */
import { boxHitsPoint, containsPoint } from '../geom.js';

const box = { x: 10, y: 20, w: 100, h: 50 };

describe('containsPoint and boxHitsPoint', () => {
  it('agree everywhere inside', () => {
    for (const p of [
      { x: 10, y: 20 },
      { x: 60, y: 45 },
      { x: 109, y: 69 },
    ]) {
      expect(containsPoint(box, p)).toBe(true);
      expect(boxHitsPoint(box, p)).toBe(true);
    }
  });

  it('agree everywhere outside', () => {
    for (const p of [
      { x: 9, y: 45 },
      { x: 111, y: 45 },
      { x: 60, y: 19 },
      { x: 60, y: 71 },
    ]) {
      expect(containsPoint(box, p)).toBe(false);
      expect(boxHitsPoint(box, p)).toBe(false);
    }
  });

  it('differ on the far edges, where a CSS box is half-open', () => {
    for (const p of [
      { x: 110, y: 45 },
      { x: 60, y: 70 },
      { x: 110, y: 70 },
    ]) {
      expect(containsPoint(box, p)).toBe(true);
      expect(boxHitsPoint(box, p)).toBe(false);
    }
  });

  it('lets two boxes sharing a border tile instead of both claiming it', () => {
    const left = { x: 0, y: 0, w: 200, h: 30 };
    const right = { x: 200, y: 0, w: 24, h: 30 };
    const onTheSeam = { x: 200, y: 15 };

    expect(containsPoint(left, onTheSeam)).toBe(true);
    expect(containsPoint(right, onTheSeam)).toBe(true);

    expect(boxHitsPoint(left, onTheSeam)).toBe(false);
    expect(boxHitsPoint(right, onTheSeam)).toBe(true);
  });

  it('never hits a rect with no area, which paints nothing', () => {
    const empty = { x: 224, y: 123, w: 0, h: 0 };
    expect(containsPoint(empty, { x: 224, y: 123 })).toBe(true);
    expect(boxHitsPoint(empty, { x: 224, y: 123 })).toBe(false);
  });
});
