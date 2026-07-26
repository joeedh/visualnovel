import {
  DEFAULT_ZOOM,
  fit,
  IDENTITY,
  panBy,
  screenToWorldDistance,
  toScreen,
  toWorld,
  cssTransformOf,
  transformOf,
  wheelFactor,
  zoomAt,
} from '../viewport.js';

describe('viewport', () => {
  it('round-trips a point through screen and world space', () => {
    const vp = { x: 120, y: -40, scale: 1.75 };
    const world = { x: 13.5, y: -220 };
    const back = toWorld(vp, toScreen(vp, world));
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.y).toBeCloseTo(world.y, 10);
  });

  it('pans by a screen delta without touching scale', () => {
    expect(panBy({ x: 10, y: 10, scale: 2 }, -4, 6)).toEqual({ x: 6, y: 16, scale: 2 });
  });

  it('keeps the world point under the cursor fixed while zooming', () => {
    const vp = { x: 33, y: -17, scale: 0.8 };
    const cursor = { x: 400, y: 300 };
    const before = toWorld(vp, cursor);
    const after = toWorld(zoomAt(vp, cursor, 1.4), cursor);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('clamps zoom and returns the same object when the clamp bites', () => {
    const atMax = { x: 0, y: 0, scale: DEFAULT_ZOOM.max };
    expect(zoomAt(atMax, { x: 0, y: 0 }, 4)).toBe(atMax);
    expect(zoomAt(IDENTITY, { x: 0, y: 0 }, 0.001).scale).toBe(DEFAULT_ZOOM.min);
  });

  // The rule the whole hit-test layer depends on: slop is screen pixels, geometry is world.
  it('converts a screen distance into fewer world units as it zooms in', () => {
    expect(screenToWorldDistance({ x: 0, y: 0, scale: 2 }, 8)).toBe(4);
    expect(screenToWorldDistance({ x: 0, y: 0, scale: 0.5 }, 8)).toBe(16);
  });

  it('fits content to the centre of the surface', () => {
    const content = { x: -100, y: 0, width: 200, height: 100 };
    const vp = fit(content, { width: 800, height: 600 }, { padding: 50 });
    const centre = toScreen(vp, { x: 0, y: 50 });
    expect(centre.x).toBeCloseTo(400, 6);
    expect(centre.y).toBeCloseTo(300, 6);
  });

  it('does not magnify small content past maxScale, but does shrink large content', () => {
    const surface = { width: 800, height: 600 };
    expect(fit({ x: 0, y: 0, width: 20, height: 20 }, surface).scale).toBe(1);
    expect(
      fit({ x: 0, y: 0, width: 4000, height: 100 }, surface, { padding: 0 }).scale,
    ).toBeCloseTo(0.2, 6);
  });

  it('centres degenerate content instead of dividing by zero', () => {
    const vp = fit({ x: 5, y: 5, width: 0, height: 0 }, { width: 400, height: 200 });
    expect(vp.scale).toBe(1);
    expect(toScreen(vp, { x: 5, y: 5 })).toEqual({ x: 200, y: 100 });
  });

  it('emits an SVG transform matching its own maths', () => {
    expect(transformOf({ x: 3, y: 4, scale: 2 })).toBe('translate(3 4) scale(2)');
  });

  // The two syntaxes are not interchangeable: CSS needs units and a comma, and it drops an
  // unparseable transform silently — the HTML layer just sits at world coordinates.
  it('emits the CSS form with units and a comma, not the SVG one', () => {
    expect(cssTransformOf({ x: 3, y: 4, scale: 2 })).toBe('translate(3px, 4px) scale(2)');
  });

  it('zooms in on a negative wheel delta and out on a positive one', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });
});
