import type { PagePanel, PanelBubble, Shot } from '@vn/types';
import { aimBubble, bubblesOf, placeBubble, removeBubble, setBubbles } from '../bubbles.js';
import { setPanels } from '../panels.js';

const LINES = ['club:L1', 'club:L2', 'club:L3', 'club:L4'];

const top: PagePanel['shape'] = [
  [0, 0],
  [1, 0],
  [1, 0.5],
  [0, 0.5],
];
const bottom: PagePanel['shape'] = [
  [0, 0.5],
  [1, 0.5],
  [1, 1],
  [0, 1],
];

const panel = (
  shape: PagePanel['shape'],
  coversLines: string[],
  extra: Partial<PagePanel> = {},
): PagePanel => ({
  shape,
  framing : 'medium',
  subjects: [],
  coversLines,
  ...extra,
});

const page = (panels?: PagePanel[]): Shot[] => [
  {
    id         : 'club__page1',
    sceneId    : 'club',
    framing    : 'medium',
    location   : 'day',
    subjects   : [{ characterId: 'aiko' }],
    coversLines: ['club:L1', 'club:L2', 'club:L3'],
    status     : 'generated',
    ...(panels ? { panels } : {}),
  },
];

const two = (): PagePanel[] => [panel(top, ['club:L1', 'club:L2']), panel(bottom, ['club:L3'])];

const b1: PanelBubble = { lineId: 'club:L1', anchor: [0.2, 0.2], tail: [0.3, 0.4] };
const b3: PanelBubble = { lineId: 'club:L3', anchor: [0.5, 0.8] };

describe('setBubbles', () => {
  it('files each bubble in the panel that letters its line, and says nothing re-renders', () => {
    const op = setBubbles(page(two()), { shot: 'club__page1', bubbles: [b3, b1] });
    expect(op.ok).toBe(true);
    if (!op.ok) return;
    expect(op.shots[0]!.panels).toEqual([
      { ...panel(top, ['club:L1', 'club:L2']), bubbles: [b1] },
      { ...panel(bottom, ['club:L3']), bubbles: [b3] },
    ]);
    expect(op.message).toBe(
      'club__page1 has 2 bubble(s) placed. 1 lettered line(s) still read in the dialogue box. Nothing is drawn again.',
    );
  });

  it('keeps bubbles in the panel’s line order, whatever order they were named in', () => {
    const b2: PanelBubble = { lineId: 'club:L2', anchor: [0.7, 0.2] };
    const op = setBubbles(page(two()), { shot: 'club__page1', bubbles: [b2, b1] });
    expect(op.ok && op.shots[0]!.panels![0]!.bubbles).toEqual([b1, b2]);
  });

  it('removes every bubble with an empty list, leaving the key off the file', () => {
    const placed = setBubbles(page(two()), { shot: 'club__page1', bubbles: [b1] });
    const op = setBubbles(placed.ok ? placed.shots : [], { shot: 'club__page1', bubbles: [] });
    expect(op.ok && op.shots[0]!.panels).toEqual(two());
  });

  it('is a no-op when the page already says that', () => {
    const placed = setBubbles(page(two()), { shot: 'club__page1', bubbles: [b1, b3] });
    const again = setBubbles(placed.ok ? placed.shots : [], {
      shot   : 'club__page1',
      bubbles: [b3, b1],
    });
    expect(again).toEqual({
      ok   : false,
      error: 'club__page1 already has exactly those bubbles.',
      noop : true,
    });
  });

  it('refuses a frame, a line no panel letters, a line named twice and a point off the page', () => {
    const frame = setBubbles(page(), { shot: 'club__page1', bubbles: [b1] });
    expect(frame).toMatchObject({ ok: false, error: expect.stringContaining('single frame') });

    const unlettered = setBubbles(page([panel(top, ['club:L1'])]), {
      shot   : 'club__page1',
      bubbles: [b3],
    });
    expect(unlettered).toMatchObject({
      ok   : false,
      error: 'club:L3 is in no panel of club__page1; a bubble goes on a lettered line.',
    });

    const twice = setBubbles(page(two()), { shot: 'club__page1', bubbles: [b1, b1] });
    expect(twice).toMatchObject({ ok: false, error: expect.stringContaining('named twice') });

    const off = setBubbles(page(two()), {
      shot   : 'club__page1',
      bubbles: [{ lineId: 'club:L1', anchor: [1.2, 0] }],
    });
    expect(off).toMatchObject({ ok: false, error: expect.stringContaining('off the page') });
    expect(setBubbles(page(two()), { shot: 'nope', bubbles: [] })).toMatchObject({ ok: false });
  });
});

describe('setPanels with bubbles', () => {
  const placed = (): Shot[] => {
    const op = setBubbles(page(two()), { shot: 'club__page1', bubbles: [b1, b3] });
    return op.ok ? op.shots : [];
  };
  const args = (panels: PagePanel[]) => ({ shot: 'club__page1', panels, lineOrder: LINES });

  it('carries a page’s bubbles through a restatement that leaves each line in its panel', () => {
    const op = setPanels(
      placed(),
      args([panel(top, ['club:L1', 'club:L2'], { camera: 'low' }), panel(bottom, ['club:L3'])]),
    );
    expect(op.ok && op.shots[0]!.panels).toEqual([
      { ...panel(top, ['club:L1', 'club:L2'], { camera: 'low' }), bubbles: [b1] },
      { ...panel(bottom, ['club:L3']), bubbles: [b3] },
    ]);
  });

  it('drops the bubble of a line moved to another panel, and ignores bubbles on the input', () => {
    const op = setPanels(
      placed(),
      args([
        panel(top, ['club:L1'], { bubbles: [{ lineId: 'club:L1', anchor: [0.9, 0.9] }] }),
        panel(bottom, ['club:L2', 'club:L3']),
      ]),
    );
    expect(op.ok && op.shots[0]!.panels).toEqual([
      { ...panel(top, ['club:L1']), bubbles: [b1] },
      { ...panel(bottom, ['club:L2', 'club:L3']), bubbles: [b3] },
    ]);
  });

  it('is still a no-op when the restatement matches, bubbles included', () => {
    expect(setPanels(placed(), args(two()))).toMatchObject({ ok: false, noop: true });
  });
});

describe('the editor’s list helpers', () => {
  const list = [b1, b3];

  it('flattens a page’s bubbles in panel order', () => {
    const op = setBubbles(page(two()), { shot: 'club__page1', bubbles: [b3, b1] });
    expect(bubblesOf(op.ok ? op.shots[0]!.panels! : [])).toEqual([b1, b3]);
  });

  it('places, moves keeping the tail, aims, un-aims and removes', () => {
    expect(placeBubble(list, 'club:L2', [0.5, 0.5])).toEqual([
      b1,
      b3,
      { lineId: 'club:L2', anchor: [0.5, 0.5] },
    ]);
    expect(placeBubble(list, 'club:L1', [0.1, 0.1])).toEqual([
      b3,
      { lineId: 'club:L1', anchor: [0.1, 0.1], tail: [0.3, 0.4] },
    ]);
    expect(aimBubble(list, 'club:L3', [0.6, 0.9])).toEqual([b1, { ...b3, tail: [0.6, 0.9] }]);
    expect(aimBubble(list, 'club:L1', undefined)).toEqual([
      { lineId: 'club:L1', anchor: [0.2, 0.2] },
      b3,
    ]);
    expect(removeBubble(list, 'club:L1')).toEqual([b3]);
  });
});
