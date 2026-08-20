import type { SnapNode } from '../snapshot.js';
import { DEFAULT_RESOLVERS, nodeLabel, resolveOwner, type OwnerResolver } from '../attribution.js';

function el(extra: Partial<SnapNode>): SnapNode {
  return {
    id: 'dom:0',
    tag: 'div',
    classes: [],
    bounds: { x: 0, y: 0, w: 10, h: 10 },
    style: {},
    children: [],
    ...extra,
  };
}

describe('resolveOwner', () => {
  it('prefers data-dbg-id over everything', () => {
    const owner = resolveOwner(el({ dbgId: 'gate/approve-btn', fiberName: 'GateOverlay' }));
    expect(owner).toEqual({ id: 'gate/approve-btn', label: 'gate/approve-btn', kind: 'widget' });
  });

  it('falls back to the React fiber name', () => {
    const owner = resolveOwner(el({ fiberName: 'Runner', classes: ['beat'] }));
    expect(owner).toEqual({ id: 'Runner/div.beat', label: 'Runner/div.beat', kind: 'component' });
  });

  it('falls back to the tag/class path', () => {
    expect(resolveOwner(el({ classes: ['rail', 'left'] }))).toEqual({
      id: 'div.rail.left',
      label: 'div.rail.left',
      kind: 'element',
    });
    expect(resolveOwner(el({ elemId: 'root' })).id).toBe('div#root');
  });

  it('records the enclosing owner as parent', () => {
    const parent = resolveOwner(el({ fiberName: 'Floor' }));
    expect(resolveOwner(el({ classes: ['card'] }), parent).parent).toBe('Floor/div');
  });

  it('degrades to unknown instead of throwing', () => {
    const exploding: OwnerResolver = () => {
      throw new Error('fiber layout changed');
    };
    // A broken resolver is skipped; when no resolver returns an owner, attribution is 'unknown'
    expect(resolveOwner(el({ tag: '' }), undefined, [exploding, ...DEFAULT_RESOLVERS])).toEqual({
      id: 'unknown',
      label: 'unknown',
      kind: 'unknown',
      parent: undefined,
    });
    expect(
      resolveOwner(el({ classes: ['ok'] }), undefined, [exploding, ...DEFAULT_RESOLVERS]).id,
    ).toBe('div.ok');
  });
});

describe('nodeLabel', () => {
  it('prefers #id, then classes, then bare tag', () => {
    expect(nodeLabel(el({ elemId: 'app', classes: ['x'] }))).toBe('div#app');
    expect(nodeLabel(el({ classes: ['a', 'b'] }))).toBe('div.a.b');
    expect(nodeLabel(el({}))).toBe('div');
  });
});
