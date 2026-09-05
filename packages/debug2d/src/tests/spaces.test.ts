import { applyToPoint, IDENTITY, invert, mul, scaleMat, translateMat } from '../geom.js';
import { createSpaceRegistry } from '../spaces.js';

const registry = () =>
  createSpaceRegistry({
    css          : { parent: 'device', label: 'devicePixelRatio', matrix: scaleMat(2) },
    'world:graph': {
      parent: 'css',
      label : 'pan/zoom',
      matrix: mul(translateMat(120, 40), scaleMat(1.5)),
    },
  });

describe('geom', () => {
  it('invert undoes mul', () => {
    const m = mul(translateMat(7, -3), scaleMat(2, 4));
    const inv = invert(m);
    expect(inv).not.toBeNull();
    const round = mul(inv!, m);
    expect(round.a).toBeCloseTo(1);
    expect(round.d).toBeCloseTo(1);
    expect(round.e).toBeCloseTo(0);
    expect(round.f).toBeCloseTo(0);
  });

  it('refuses to invert a singular matrix', () => {
    expect(invert(scaleMat(0))).toBeNull();
  });
});

describe('SpaceRegistry', () => {
  it('composes through device', () => {
    const m = registry().transform('world:graph', 'device')!;
    // world point (10, 10) → css (135, 55) → device (270, 110)
    expect(applyToPoint(m, { x: 10, y: 10 })).toEqual({ x: 270, y: 110 });
  });

  it('returns identity for from === to', () => {
    expect(registry().transform('css', 'css')).toEqual(IDENTITY);
  });

  it('round-trips convert', () => {
    const reg = registry();
    const r = { x: 10, y: 20, w: 30, h: 40 };
    const there = reg.convert(r, 'world:graph', 'device');
    const back = reg.convert(there, 'device', 'world:graph');
    expect(back.x).toBeCloseTo(r.x);
    expect(back.y).toBeCloseTo(r.y);
    expect(back.w).toBeCloseTo(r.w);
    expect(back.h).toBeCloseTo(r.h);
  });

  it('returns null for an unknown space — never a silent identity', () => {
    expect(registry().transform('world:nope', 'device')).toBeNull();
    expect(registry().transform('device', 'world:nope')).toBeNull();
    expect(() => registry().convert({ x: 0, y: 0, w: 1, h: 1 }, 'world:nope', 'css')).toThrow(
      /world:nope/,
    );
  });

  it('preserves step labels in chain()', () => {
    expect(
      registry()
        .chain('world:graph', 'device')!
        .map((s) => s.label),
    ).toEqual(['pan/zoom', 'devicePixelRatio']);
  });

  it('labels inverse legs and stops at the lowest common ancestor', () => {
    // css → world:graph goes straight down; devicePixelRatio must not appear.
    expect(
      registry()
        .chain('css', 'world:graph')!
        .map((s) => s.label),
    ).toEqual(['pan/zoom⁻¹']);
  });

  it('re-reads matrix thunks at query time', () => {
    let zoom = 1;
    const reg = createSpaceRegistry({
      css          : { parent: 'device', label: 'devicePixelRatio', matrix: IDENTITY },
      'world:graph': { parent: 'css', label: 'pan/zoom', matrix: () => scaleMat(zoom) },
    });
    expect(applyToPoint(reg.transform('world:graph', 'css')!, { x: 10, y: 0 }).x).toBe(10);
    zoom = 3;
    expect(applyToPoint(reg.transform('world:graph', 'css')!, { x: 10, y: 0 }).x).toBe(30);
  });
});
