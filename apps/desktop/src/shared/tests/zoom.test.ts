import { ZOOM_STEPS, zoomAfter, zoomLabel } from '../zoom.js';

describe('zoomAfter', () => {
  it('steps through the table and clamps at both ends', () => {
    expect(zoomAfter(1, 'in')).toBe(1.1);
    expect(zoomAfter(1, 'out')).toBe(0.9);
    expect(zoomAfter(3, 'in')).toBe(3);
    expect(zoomAfter(0.5, 'out')).toBe(0.5);
    expect(ZOOM_STEPS).toContain(1);
  });

  it('steps from the nearest step for a factor outside the table, and resets to 1', () => {
    expect(zoomAfter(1.3, 'in')).toBe(1.5);
    expect(zoomAfter(1.3, 'out')).toBe(1.1);
    expect(zoomAfter(2.2, 'reset')).toBe(1);
  });
});

describe('zoomLabel', () => {
  it('reads as a percentage', () => {
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(0.67)).toBe('67%');
    expect(zoomLabel(1.25)).toBe('125%');
  });
});
