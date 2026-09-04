import { countClick, DOUBLE_CLICK_MS, NO_CLICK } from '../treeview.js';

describe('countClick', () => {
  test('the first click on a row is never a second one', () => {
    const { again, next } = countClick(NO_CLICK, 'character:aiko', 100);
    expect(again).toBe(false);
    expect(next).toEqual({ id: 'character:aiko', at: 100 });
  });

  test('the same row inside the window is a second click', () => {
    const first = countClick(NO_CLICK, 'character:aiko', 100);
    const { again } = countClick(first.next, 'character:aiko', 100 + DOUBLE_CLICK_MS - 1);
    expect(again).toBe(true);
  });

  test('the same row past the window is a fresh first click', () => {
    const first = countClick(NO_CLICK, 'character:aiko', 100);
    const second = countClick(first.next, 'character:aiko', 100 + DOUBLE_CLICK_MS);
    expect(second.again).toBe(false);
    expect(second.next).toEqual({ id: 'character:aiko', at: 100 + DOUBLE_CLICK_MS });
  });

  test('a different row inside the window is not a second click, and arms itself', () => {
    const first = countClick(NO_CLICK, 'character:aiko', 100);
    const second = countClick(first.next, 'character:ren', 120);
    expect(second.again).toBe(false);
    expect(second.next).toEqual({ id: 'character:ren', at: 120 });
  });

  // A counted second click resets the latch rather than becoming the first of the next pair, so
  // three clicks are one rename rather than two
  test('a counted second click resets the latch', () => {
    const first = countClick(NO_CLICK, 'character:aiko', 100);
    const second = countClick(first.next, 'character:aiko', 200);
    expect(second.again).toBe(true);
    expect(second.next).toEqual(NO_CLICK);
    expect(countClick(second.next, 'character:aiko', 300).again).toBe(false);
  });
});
