/**
 * Golden tests: the explainPick text IS the product (research §6), so it is asserted
 * verbatim. A failing golden means the format changed — edit deliberately or fix the
 * regression; the friction is intended.
 */
import { assembleFrame, makeTestFrame } from '../frame.js';
import { IDENTITY } from '../geom.js';
import { createSpaceRegistry } from '../spaces.js';
import { DOM_CAPS } from '../dom/source.js';
import { fragmentsFromSnapshot } from '../dom/stacking.js';
import type { SnapNode } from '../dom/snapshot.js';
import { explainPickFrame } from './explainPick.js';

const owner = (id: string, kind = 'element') => ({ id, label: id, kind });

describe('explainPickFrame', () => {
  it('prints the ordered rejection log for the research §6 scenario', () => {
    const frame = makeTestFrame([
      { id: 'bg', bounds: { x: 0, y: 0, w: 800, h: 600 }, owner: owner('div.app') },
      { id: 'rail', bounds: { x: 0, y: 0, w: 120, h: 600 }, owner: owner('div.rail') },
      {
        id: 'panel',
        bounds: { x: 0, y: 0, w: 800, h: 600 },
        owner: owner('div.panel'),
        clip: [{ rect: { x: 0, y: 0, w: 120, h: 600 }, by: 'rail' }],
      },
      {
        id: 'modal',
        bounds: { x: 300, y: 200, w: 300, h: 200 },
        owner: owner('div.modal'),
        style: { alpha: 1, zIndex: 999 },
        zContext: { by: 'stage', byLabel: 'div.stage', reason: 'transform' },
      },
      {
        id: 'tooltip',
        bounds: { x: 380, y: 280, w: 100, h: 60 },
        owner: owner('div.tooltip'),
        style: { alpha: 0 },
      },
      { id: 'button', bounds: { x: 350, y: 250, w: 120, h: 80 }, owner: owner('button.approve') },
      {
        id: 'scrim',
        bounds: { x: 0, y: 0, w: 800, h: 600 },
        owner: owner('div.scrim'),
        pick: { mode: 'none' },
      },
    ]);

    expect(explainPickFrame(frame, { x: 400, y: 300 })).toBe(
      [
        'explainPick(400, 300) css → winner + 5 rejections',
        "  ✗  test  #scrim    div.scrim       pick='none' (pointer-events)",
        '  ✓  test  #button   button.approve  wins (z=5)',
        "  ✗  test  #tooltip  div.tooltip     alpha 0 — but pick='auto' (clickable while invisible)",
        '  ✗  test  #modal    div.modal       z-index 999 ignored — div.stage established a stacking context via transform',
        '  ✗  test  #panel    div.panel       clipped away by div.rail',
        '  ✗  test  #bg       div.app         below winner (z=0 < 5)',
      ].join('\n'),
    );
  });

  it('surfaces an oracle disagreement with a ⚠ line instead of picking a side', () => {
    const frame = makeTestFrame(
      [
        { id: 'a', bounds: { x: 0, y: 0, w: 100, h: 100 } },
        { id: 'b', bounds: { x: 0, y: 0, w: 100, h: 100 } },
      ],
      { oracle: { point: { x: 50, y: 50 }, ids: ['a', 'b'] } },
    );

    expect(explainPickFrame(frame, { x: 50, y: 50 })).toBe(
      [
        'explainPick(50, 50) css → winner + 1 rejection',
        '  ✓  test  #b  b  wins (z=1)',
        '  ✗  test  #a  a  below winner (z=0 < 1)',
        '  ⚠ oracle disagreement: elementsFromPoint ranks #a above #b — computed',
        '    stacking order may be wrong here, or the DOM adapter is stale relative to this frame.',
      ].join('\n'),
    );
  });

  it('stays quiet when the oracle agrees', () => {
    const frame = makeTestFrame(
      [
        { id: 'a', bounds: { x: 0, y: 0, w: 100, h: 100 } },
        { id: 'b', bounds: { x: 0, y: 0, w: 100, h: 100 } },
      ],
      { oracle: { point: { x: 50, y: 50 }, ids: ['b', 'a'] } },
    );
    expect(explainPickFrame(frame, { x: 50, y: 50 })).not.toContain('⚠');
  });

  it('flags an invisible-but-clickable winner', () => {
    const frame = makeTestFrame([
      { id: 'ghost', bounds: { x: 0, y: 0, w: 10, h: 10 }, style: { alpha: 0 } },
    ]);
    expect(explainPickFrame(frame, { x: 5, y: 5 })).toContain(
      'wins (z=0) ⚠ alpha 0 — clickable while invisible',
    );
  });

  it('derives the flagship line mechanically from the stacking walk', () => {
    // No hand-set zContext anywhere: the culprit comes out of fragmentsFromSnapshot.
    const el = (
      id: string,
      style: SnapNode['style'],
      classes: string[],
      children: SnapNode[] = [],
    ): SnapNode => ({
      id,
      tag: 'div',
      classes,
      bounds: { x: 0, y: 0, w: 800, h: 600 },
      style,
      children,
    });
    const modal = el('modal', { position: 'absolute', zIndex: '999' }, ['modal']);
    modal.bounds = { x: 300, y: 200, w: 300, h: 200 };
    const toast = el('toast', { position: 'absolute', zIndex: '1' }, ['toast']);
    toast.bounds = { x: 350, y: 250, w: 120, h: 80 };
    const tree = el(
      'root',
      {},
      ['root'],
      [el('stage', { transform: 'matrix(1, 0, 0, 1, 0, 0)' }, ['stage'], [modal]), toast],
    );

    const frame = assembleFrame({
      fragments: fragmentsFromSnapshot(tree),
      spaces: createSpaceRegistry({
        css: { parent: 'device', label: 'devicePixelRatio', matrix: IDENTITY },
      }),
      caps: { dom: DOM_CAPS },
      fidelity: 'sampled',
    });

    expect(explainPickFrame(frame, { x: 400, y: 300 })).toBe(
      [
        'explainPick(400, 300) css → winner + 3 rejections',
        '  ✓  dom  #toast  div.toast  wins (z=3)',
        '  ✗  dom  #modal  div.modal  z-index 999 ignored — div.stage established a stacking context via transform',
        '  ✗  dom  #stage  div.stage  below winner (z=1 < 3)',
        '  ✗  dom  #root   div.root   below winner (z=0 < 3)',
      ].join('\n'),
    );
  });
});
