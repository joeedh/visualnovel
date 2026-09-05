import type { Fragment } from '../../types.js';
import type { SnapNode, SnapStyle } from '../snapshot.js';
import { contextReason, fragmentsFromSnapshot } from '../stacking.js';

function el(
  id: string,
  style: SnapStyle = {},
  children: SnapNode[] = [],
  extra: Partial<SnapNode> = {},
): SnapNode {
  return {
    id,
    tag    : 'div',
    classes: [],
    bounds : { x: 0, y: 0, w: 100, h: 100 },
    style,
    children,
    ...extra,
  };
}

const zOf = (frags: Fragment[], id: string) => {
  const f = frags.find((f) => f.id === id);
  if (!f) throw new Error(`no fragment ${id}`);
  return f;
};

describe('fragmentsFromSnapshot', () => {
  it('ranks z-index 999 inside a transform ancestor below a low-z sibling, and retains the culprit', () => {
    const tree = el('root', {}, [
      el('stage', { transform: 'matrix(2, 0, 0, 2, 0, 0)' }, [
        el('modal', { position: 'absolute', zIndex: '999' }),
      ]),
      el('toast', { position: 'absolute', zIndex: '1' }),
    ]);
    // Make the culprit label readable in the explain output.
    tree.children[0]!.classes = ['stage'];

    const frags = fragmentsFromSnapshot(tree);
    expect(zOf(frags, 'modal').z).toBeLessThan(zOf(frags, 'toast').z);
    expect(zOf(frags, 'modal').zContext).toEqual({
      by     : 'stage',
      byLabel: 'div.stage',
      reason : 'transform',
    });
    // The sibling's z-index is scoped by the real root, so it carries no note
    expect(zOf(frags, 'toast').zContext).toBeUndefined();
    expect(zOf(frags, 'modal').style.zIndex).toBe(999);
  });

  it('paints negative-z contexts above the root background but below in-flow content', () => {
    const tree = el('root', {}, [
      el('under', { position: 'absolute', zIndex: '-1' }),
      el('content', {}),
    ]);
    const frags = fragmentsFromSnapshot(tree);
    expect(zOf(frags, 'root').z).toBeLessThan(zOf(frags, 'under').z);
    expect(zOf(frags, 'under').z).toBeLessThan(zOf(frags, 'content').z);
  });

  it('treats opacity < 1 as establishing a stacking context', () => {
    const tree = el('root', {}, [
      el('faded', { opacity: 0.5 }, [el('modal', { position: 'absolute', zIndex: '999' })]),
      el('toast', { position: 'absolute', zIndex: '1' }),
    ]);
    const frags = fragmentsFromSnapshot(tree);
    expect(zOf(frags, 'modal').z).toBeLessThan(zOf(frags, 'toast').z);
    expect(zOf(frags, 'modal').zContext).toMatchObject({ by: 'faded', reason: 'opacity: 0.5' });
  });

  it('orders positive-z contexts by z ascending, document order on ties', () => {
    const tree = el('root', {}, [
      el('a', { position: 'absolute', zIndex: '5' }),
      el('b', { position: 'absolute', zIndex: '2' }),
      el('c', { position: 'absolute', zIndex: '2' }),
    ]);
    const frags = fragmentsFromSnapshot(tree);
    expect(zOf(frags, 'b').z).toBeLessThan(zOf(frags, 'c').z);
    expect(zOf(frags, 'c').z).toBeLessThan(zOf(frags, 'a').z);
  });

  it('propagates pointer-events: none to children until overridden', () => {
    const tree = el('root', {}, [
      el('scrim', { pointerEvents: 'none' }, [
        el('inert', {}),
        el('button', { pointerEvents: 'auto' }),
      ]),
    ]);
    const frags = fragmentsFromSnapshot(tree);
    expect(zOf(frags, 'scrim').pick.mode).toBe('none');
    expect(zOf(frags, 'inert').pick.mode).toBe('none');
    expect(zOf(frags, 'button').pick.mode).toBe('auto');
  });

  it('records overflow clips with the clipping ancestor attributed', () => {
    const rail = el('rail', { overflowY: 'hidden' }, [el('row', {})]);
    rail.bounds = { x: 0, y: 0, w: 50, h: 200 };
    const frags = fragmentsFromSnapshot(el('root', {}, [rail]));
    expect(zOf(frags, 'row').clip).toEqual([{ rect: { x: 0, y: 0, w: 50, h: 200 }, by: 'rail' }]);
    expect(zOf(frags, 'rail').clip).toBeUndefined();
  });

  it('does not clip a position: fixed descendant by a static overflow ancestor it escapes', () => {
    const shell = el('shell', { overflowX: 'hidden', overflowY: 'hidden' }, [
      el('panel', { position: 'fixed' }),
    ]);
    shell.bounds = { x: 0, y: 0, w: 0, h: 0 };
    const frags = fragmentsFromSnapshot(el('root', {}, [shell]));
    expect(zOf(frags, 'panel').clip).toBeUndefined();
  });

  it('clips a position: fixed descendant along its real containing-block chain', () => {
    const tree = el('root', { overflowY: 'hidden' }, [
      el('stage', { transform: 'matrix(1, 0, 0, 1, 0, 0)', overflowY: 'hidden' }, [
        el('panel', { position: 'fixed' }),
      ]),
    ]);
    tree.bounds = { x: 0, y: 0, w: 300, h: 300 };
    tree.children[0]!.bounds = { x: 10, y: 10, w: 50, h: 50 };
    const frags = fragmentsFromSnapshot(tree);
    // `stage` is an ordinary (non-escaping) child of `root`, so root's own clip still applies
    // to everything painted through `stage`'s subtree, `panel` included.
    expect(zOf(frags, 'panel').clip).toEqual([
      { rect: { x: 0, y: 0, w: 300, h: 300 }, by: 'root' },
      { rect: { x: 10, y: 10, w: 50, h: 50 }, by: 'stage' },
    ]);
  });

  it('emits in-flow content in document order', () => {
    const tree = el('root', {}, [el('a', {}, [el('a1', {})]), el('b', {})]);
    expect(fragmentsFromSnapshot(tree).map((f) => f.id)).toEqual(['root', 'a', 'a1', 'b']);
  });
});

describe('contextReason', () => {
  it.each([
    ['transform', { transform: 'matrix(1, 0, 0, 1, 5, 5)' }, 'transform'],
    ['filter', { filter: 'blur(2px)' }, 'filter'],
    ['backdrop-filter', { backdropFilter: 'blur(2px)' }, 'backdrop-filter'],
    ['isolation', { isolation: 'isolate' }, 'isolation: isolate'],
    ['will-change', { willChange: 'transform' }, 'will-change'],
    ['contain', { contain: 'paint' }, 'contain'],
    ['position: fixed', { position: 'fixed' }, 'position: fixed'],
    ['positioned z-index', { position: 'relative', zIndex: '3' }, 'z-index on positioned element'],
  ] satisfies [string, SnapStyle, string][])('%s', (_name, style, reason) => {
    expect(contextReason(el('x', style))).toBe(reason);
  });

  it.each([
    ['static default', {}],
    ['positioned without z-index', { position: 'relative' }],
    ['unpositioned z-index', { zIndex: '4' }],
    ['opacity 1', { opacity: 1 }],
    ['transform none', { transform: 'none' }],
  ] satisfies [string, SnapStyle][])('no context for %s', (_name, style) => {
    expect(contextReason(el('x', style))).toBeNull();
  });
});
