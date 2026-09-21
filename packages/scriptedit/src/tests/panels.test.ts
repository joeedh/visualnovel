import type { PagePanel, Shot } from '@vn/types';
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

const shots = (panels?: PagePanel[]): Shot[] => [
  {
    id         : 'club__page1',
    sceneId    : 'club',
    framing    : 'medium',
    location   : 'day',
    subjects   : [{ characterId: 'aiko' }, { characterId: 'ben' }],
    coversLines: ['club:L1', 'club:L2', 'club:L3'],
    ...(panels ? { panels } : {}),
  },
  {
    id         : 'club__beat2',
    sceneId    : 'club',
    framing    : 'close',
    location   : 'day',
    subjects   : [{ characterId: 'ben' }],
    coversLines: ['club:L4'],
  },
];

const args = (panels: PagePanel[], shot = 'club__page1') => ({ shot, panels, lineOrder: LINES });

describe('setPanels', () => {
  it('writes the panels with their lines in screenplay order, and says the page re-renders', () => {
    const input = shots();
    const op = setPanels(
      input,
      args([panel(top, ['club:L2', 'club:L1']), panel(bottom, ['club:L3'])]),
    );
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.panels!.map((p) => p.coversLines)).toEqual([
      ['club:L1', 'club:L2'],
      ['club:L3'],
    ]);
    expect(op.shots[1]).toBe(input[1]);
    expect(op.message).toContain('is a page now');
    expect(op.message).toContain('drawn again');
  });

  it('moves a line between two panels of the same page', () => {
    const page = shots([panel(top, ['club:L1', 'club:L2']), panel(bottom, ['club:L3'])]);
    const op = setPanels(
      page,
      args([panel(top, ['club:L1']), panel(bottom, ['club:L2', 'club:L3'])]),
    );
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.panels!.map((p) => p.coversLines)).toEqual([
      ['club:L1'],
      ['club:L2', 'club:L3'],
    ]);
    expect(op.message).not.toContain('is a page now');
  });

  it('names a covered line no panel letters, and still writes', () => {
    const op = setPanels(shots(), args([panel(top, ['club:L1']), panel(bottom, ['club:L3'])]));
    if (!op.ok) throw new Error(op.error);
    expect(op.message).toContain('club:L2 is in no panel');
  });

  it('an empty list makes the page a frame again', () => {
    const op = setPanels(shots([panel(top, ['club:L1'])]), args([]));
    if (!op.ok) throw new Error(op.error);
    expect('panels' in op.shots[0]!).toBe(false);
    expect(op.message).toContain('single frame');
  });

  it('refuses a line the page does not cover, and a line in two panels', () => {
    expect(setPanels(shots(), args([panel(top, ['club:L4'])]))).toMatchObject({
      ok   : false,
      error: 'Panel 1 letters club:L4, which club__page1 does not cover.',
    });
    expect(
      setPanels(shots(), args([panel(top, ['club:L1']), panel(bottom, ['club:L1'])])),
    ).toMatchObject({
      ok   : false,
      error: 'club:L1 is in panel 1 and panel 2; a line is lettered once.',
    });
  });

  it('refuses a panel casting someone the page does not frame', () => {
    const op = setPanels(
      shots(),
      args([panel(top, ['club:L1'], { subjects: [{ characterId: 'cho' }] })]),
    );
    expect(op).toMatchObject({ ok: false, error: expect.stringContaining('casts "cho"') });
  });

  it('refuses a bad outline', () => {
    expect(
      setPanels(
        shots(),
        args([
          panel(
            [
              [0, 0],
              [1, 1],
            ],
            [],
          ),
        ]),
      ),
    ).toMatchObject({
      ok   : false,
      error: 'Panel 1 needs at least three corners.',
    });
    expect(
      setPanels(
        shots(),
        args([
          panel(
            [
              [0, 0],
              [1.2, 0],
              [1, 1],
            ],
            [],
          ),
        ]),
      ),
    ).toMatchObject({
      ok   : false,
      error: expect.stringContaining('off the page (1.2, 0)'),
    });
  });

  it('refuses a no-op by name, for a page and for a frame', () => {
    const panels = [panel(top, ['club:L1', 'club:L2']), panel(bottom, ['club:L3'])];
    expect(setPanels(shots(panels), args(panels))).toMatchObject({ ok: false, noop: true });
    expect(setPanels(shots(), args([]))).toMatchObject({ ok: false, noop: true });
    expect(setPanels(shots(), args([], 'club__nope'))).toMatchObject({
      ok   : false,
      error: 'No shot "club__nope" in this scene.',
    });
  });
});
