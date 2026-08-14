import { layoutGraph } from '../../../graph/layout.js';
import { DURATION, easeOutCubic, tweenLayout } from '../tween.js';
import type { Graph } from '../../../graph/types.js';

const chain: Graph = {
  nodes: [
    { id: 'a', width: 100, height: 50 },
    { id: 'b', width: 100, height: 50 },
  ],
  edges: [{ id: 'a->b', from: 'a', to: 'b' }],
};

/** The same two scenes with a third spliced between them — every node moves. */
const spliced: Graph = {
  nodes: [...chain.nodes, { id: 'c', width: 100, height: 50 }],
  edges: [
    { id: 'a->c', from: 'a', to: 'c' },
    { id: 'c->b', from: 'c', to: 'b' },
  ],
};

const from = layoutGraph(chain);
const to = layoutGraph(spliced);

describe('easeOutCubic', () => {
  it('starts fast and ends still', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('tweenLayout', () => {
  it('starts at the old positions with the new topology', () => {
    const at0 = tweenLayout(from, to, 0);
    expect(at0.nodes.map((n) => n.id)).toEqual(to.nodes.map((n) => n.id));
    expect(at0.byId.get('b')?.y).toBe(from.byId.get('b')?.y);
    expect(at0.byId.get('b')?.y).not.toBe(to.byId.get('b')?.y);
  });

  it('returns the target itself once done, which is what stops the animation loop', () => {
    expect(tweenLayout(from, to, 1)).toBe(to);
    expect(tweenLayout(from, to, 2)).toBe(to);
  });

  it('moves a node that exists in both, and only towards its destination', () => {
    const b0 = from.byId.get('b')?.y ?? 0;
    const b1 = to.byId.get('b')?.y ?? 0;
    const mid = tweenLayout(from, to, 0.5).byId.get('b')?.y ?? 0;
    expect(mid).toBeGreaterThan(b0);
    expect(mid).toBeLessThan(b1);
  });

  it('starts a brand-new node at its destination — it has nowhere to travel from', () => {
    const mid = tweenLayout(from, to, 0.5);
    expect(mid.byId.get('c')).toEqual(to.byId.get('c'));
  });

  it('recomputes bounds, so a fit mid-tween frames what is actually drawn', () => {
    const mid = tweenLayout(from, to, 0.5);
    expect(mid.bounds.height).toBeLessThan(to.bounds.height);
    expect(mid.bounds.height).toBeGreaterThan(from.bounds.height);
  });

  it('leaves byId consistent with nodes', () => {
    const mid = tweenLayout(from, to, 0.3);
    for (const node of mid.nodes) expect(mid.byId.get(node.id)).toBe(node);
  });
});

it('animates for long enough to read as motion and not so long as to be a wait', () => {
  expect(DURATION).toBeGreaterThanOrEqual(200);
  expect(DURATION).toBeLessThanOrEqual(500);
});
