import { makeTestFrame, staticSource } from '../../frame.js';
import { scaleMat } from '../../geom.js';
import { createSpaceRegistry } from '../../spaces.js';
import { createDebugger } from '../engine.js';

const frame = () =>
  makeTestFrame([
    { id: 'bg', bounds: { x: 0, y: 0, w: 800, h: 600 }, tags: ['chrome'] },
    {
      id: 'card',
      bounds: { x: 100, y: 100, w: 200, h: 150 },
      tags: ['card'],
      owner: { id: 'Floor/card', label: 'Floor/card', kind: 'component', parent: 'Floor' },
    },
    {
      id: 'label',
      bounds: { x: 110, y: 110, w: 80, h: 20 },
      owner: { id: 'Floor/label', label: 'Floor/label', kind: 'component', parent: 'Floor/card' },
    },
    {
      id: 'ghost',
      bounds: { x: 150, y: 120, w: 40, h: 40 },
      style: { alpha: 0 },
    },
    {
      id: 'scrim',
      bounds: { x: 0, y: 0, w: 800, h: 600 },
      pick: { mode: 'none' },
    },
  ]);

const dbg = () => createDebugger({ sources: [staticSource(frame())] });

describe('at()', () => {
  it('returns the stack top-first: z descending, then FragId', () => {
    expect(
      dbg()
        .at(150, 130)
        .fragments.map((f) => f.id),
    ).toEqual(['ghost', 'label', 'card', 'bg']);
  });

  it('is deterministic between runs', () => {
    const a = dbg()
      .at(150, 130)
      .fragments.map((f) => f.id);
    const b = dbg()
      .at(150, 130)
      .fragments.map((f) => f.id);
    expect(a).toEqual(b);
  });

  it("defaults to pick geometry: pointer-events 'none' fragments are not in a click's stack", () => {
    const ids = dbg()
      .at(150, 130)
      .fragments.map((f) => f.id);
    expect(ids).not.toContain('scrim');
  });

  it("includes pick='none' fragments when using 'paint'", () => {
    const ids = dbg()
      .at(150, 130, { using: 'paint' })
      .fragments.map((f) => f.id);
    expect(ids).toContain('scrim');
  });

  it('an alpha-0 fragment with pick auto tops the stack — invisible but clickable', () => {
    const top = dbg().at(160, 130).first();
    expect(top?.id).toBe('ghost');
    expect(top?.style.alpha).toBe(0);
  });

  it('respects pick slop', () => {
    const d = createDebugger({
      sources: [
        staticSource(
          makeTestFrame([
            {
              id: 'wire',
              bounds: { x: 100, y: 100, w: 40, h: 2 },
              pick: { mode: 'auto', slop: 4 },
            },
          ]),
        ),
      ],
    });
    expect(d.at(120, 105).length).toBe(1);
    expect(d.at(120, 110).length).toBe(0);
  });

  it('queries in a registered non-css space through the registry', () => {
    const spaces = createSpaceRegistry({
      css: { parent: 'device', label: 'devicePixelRatio', matrix: scaleMat(1) },
      'world:graph': { parent: 'css', label: 'pan/zoom', matrix: scaleMat(2) },
    });
    const d = createDebugger({
      sources: [
        staticSource(
          makeTestFrame([{ id: 'node', bounds: { x: 100, y: 100, w: 50, h: 50 } }], { spaces }),
        ),
      ],
      spaces: { 'world:graph': { parent: 'css', label: 'pan/zoom', matrix: scaleMat(2) } },
    });
    // world point (60, 60) lands at css (120, 120), inside the node.
    expect(d.at(60, 60, { space: 'world:graph' }).length).toBe(1);
    expect(d.at(60, 60).length).toBe(0);
  });

  it('reports sources whose fragments live in an unreachable space — never zeros', () => {
    const d = createDebugger({
      sources: [
        staticSource(
          makeTestFrame([
            { id: 'orphan', bounds: { x: 0, y: 0, w: 10, h: 10 }, space: 'world:lost' },
          ]),
        ),
      ],
    });
    const r = d.at(5, 5);
    expect(r.length).toBe(0);
    expect(r.unsupported).toEqual(['test']);
    expect(r.explain()).toContain("⚠ source 'test' could not answer this query");
  });
});

describe('inAABB()', () => {
  const rect = { x: 90, y: 90, w: 120, h: 120 };
  it('intersect / contain / center modes', () => {
    const ids = (mode: 'intersect' | 'contain' | 'center') =>
      dbg()
        .inAABB(rect, { mode })
        .fragments.map((f) => f.id);
    expect(ids('intersect')).toEqual(['scrim', 'ghost', 'label', 'card', 'bg']);
    expect(ids('contain')).toEqual(['ghost', 'label']);
    expect(ids('center')).toEqual(['ghost', 'label', 'card']);
  });
});

describe('structural queries', () => {
  it('byOwner + descendants expands through owner parent links', () => {
    const ids = dbg()
      .byOwner('Floor/card')
      .descendants()
      .fragments.map((f) => f.id);
    expect(ids).toEqual(['label', 'card']);
  });

  it('byTag / bySource / where filter the whole frame', () => {
    expect(
      dbg()
        .byTag('card')
        .fragments.map((f) => f.id),
    ).toEqual(['card']);
    expect(dbg().bySource('test').length).toBe(5);
    expect(
      dbg()
        .where((f) => f.style.alpha === 0)
        .fragments.map((f) => f.id),
    ).toEqual(['ghost']);
  });

  it('owners() collapses fragments to owning nodes, top-first', () => {
    const owners = dbg().owners();
    expect(owners.map((o) => o.owner.id)).toEqual([
      'scrim',
      'ghost',
      'Floor/label',
      'Floor/card',
      'bg',
    ]);
    expect(owners.every((o) => o.fragments === 1)).toBe(true);
  });

  it('chains keep the ordering contract', () => {
    const r = dbg()
      .inAABB({ x: 90, y: 90, w: 120, h: 120 })
      .where((f) => f.pick.mode !== 'none');
    expect(r.fragments.map((f) => f.id)).toEqual(['ghost', 'label', 'card', 'bg']);
  });
});
