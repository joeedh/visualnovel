import { routeEdges } from '../../../../graph/edges.js';
import { layoutGraph } from '../../../../graph/layout.js';
import { grabAt } from '../grab.js';
import { CARD } from '../graph.js';

/** Two cards, one wire: the smallest graph with both a handle and an arrowhead in it. */
const chain = () => {
  const layout = layoutGraph({
    nodes: [
      { id: 'a', ...CARD },
      { id: 'b', ...CARD },
    ],
    edges: [{ id: 'a#next', from: 'a', to: 'b' }],
  });
  return { layout, routes: routeEdges(layout, [{ id: 'a#next', from: 'a', to: 'b' }]) };
};

const NONE: ReadonlySet<string> = new Set();

describe('grabAt', () => {
  const { layout, routes } = chain();
  const a = layout.byId.get('a')!;
  const b = layout.byId.get('b')!;
  const handle = { x: a.x + a.width / 2, y: a.y + a.height };
  const head = routes[0]!.points[routes[0]!.points.length - 1]!;

  it('takes the handle from either side of the card edge it sits on', () => {
    for (const dy of [-8, 0, 8]) {
      expect(grabAt(layout.nodes, routes, { x: handle.x, y: handle.y + dy }, 15, NONE)).toEqual({
        kind: 'connect',
        scene: 'a',
      });
    }
  });

  it('takes the arrowhead from inside the target card, where pick would answer "card"', () => {
    expect(grabAt(layout.nodes, routes, { x: head.x, y: head.y + 8 }, 15, NONE)).toEqual({
      kind: 'unwire',
      edge: 'a#next',
    });
    expect(b.y).toBeCloseTo(head.y, 6);
  });

  it('answers nothing in the middle of a card, so the press becomes a splice drag', () => {
    const middle = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    expect(grabAt(layout.nodes, routes, middle, 15, NONE)).toBeNull();
  });

  it('does not offer a stub a handle — there is no scene there to wire from', () => {
    expect(grabAt(layout.nodes, routes, handle, 15, new Set(['a']))).toBeNull();
  });

  it('scales with the radius it is given, since grab is authored in screen pixels', () => {
    const far = { x: handle.x, y: handle.y + 20 };
    expect(grabAt(layout.nodes, routes, far, 15, NONE)).toBeNull();
    expect(grabAt(layout.nodes, routes, far, 30, NONE)).toEqual({ kind: 'connect', scene: 'a' });
  });

  // A wide enough radius puts both discs in range at once; wiring outward is the likelier
  // intent, and the tie has to break the same way every time either way.
  it('prefers a handle to an arrowhead when the two discs overlap', () => {
    const between = { x: handle.x, y: (handle.y + head.y) / 2 };
    const radius = Math.abs(head.y - handle.y);
    expect(grabAt(layout.nodes, routes, between, radius, NONE)).toEqual({
      kind: 'connect',
      scene: 'a',
    });
  });
});
