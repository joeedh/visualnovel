import type { Invocation } from '@vn/commands';
import type { PanelBubble } from '@vn/types';
import type { BubbleSave, SceneCoverage } from '../../../../src/shared/ipc.js';

jest.mock('pathux', () => ({ KeyMap: class {} }), { virtual: true });
jest.mock('../../../api.js', () => ({ api: { invoke: jest.fn() } }));
jest.mock('../../app/bridge.js', () => ({ exec: jest.fn(), onInvalidate: jest.fn() }));
jest.mock('../../app/editor.js', () => ({ VnEditor: class {}, registerEditor: jest.fn() }));
jest.mock('../../app/keymap.js', () => ({ hotkeys: jest.fn() }));
jest.mock('../../interactions/gestures.js', () => ({ gestureState: jest.fn() }));
jest.mock('../../interactions/timeline.js', () => ({ coverState: jest.fn() }));
jest.mock('../../tour/anchors.js', () => ({ redrawing: jest.fn(), watchKeymap: jest.fn() }));
jest.mock('../../chrome/showmenu.js', () => ({}));
jest.mock('../../widgets/modelmenu.js', () => ({}));
jest.mock('../../play/bubble.js', () => ({}));

// This repository's esbuild transform does not hoist mocks ahead of static imports.
const { api } = require('../../../api.js') as typeof import('../../../api.js');
const { exec } = require('../../app/bridge.js') as typeof import('../../app/bridge.js');
const { PageEditor } = require('../page.js') as typeof import('../page.js');
const { pageTimings } = require('../../app/timings.js') as typeof import('../../app/timings.js');

/** Exercise save ordering without constructing the path.ux screen or measuring a browser layout. */
interface SavingPage {
  ui: { shotId: string };
  data: SceneCoverage;
  bubbleDraft: PanelBubble[] | null;
  bubbleWrites: Set<Invocation>;
  loadVersion: number;
  invalidated(invocation?: Invocation): void;
  commitBubbles(bubbles: PanelBubble[], progress: string): Promise<void>;
  load(): Promise<void>;
  repaint: jest.Mock;
  rebuild: jest.Mock;
  say: jest.Mock;
}

const coverage = {
  sceneId: 's',
  shots  : [{ id: 's__page', panels: [] }],
  lines  : [],
} as unknown as SceneCoverage;
const bubbles = (x: number): PanelBubble[] => [{ lineId: 's:L1', anchor: [x, 0.3] }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function editor(): SavingPage {
  return Object.assign(Object.create(PageEditor.prototype), {
    ui          : { shotId: 's__page' },
    data        : coverage,
    shown       : 's__page',
    bubbleDraft : null,
    bubbleWrites: new Set(),
    loadVersion : 0,
    revision    : 0,
    beginBusy   : jest.fn(),
    settleBusy  : jest.fn(),
    repaint     : jest.fn(),
    rebuild     : jest.fn(),
    say         : jest.fn(),
  });
}

function success(placed = bubbles(0.7)) {
  const data: BubbleSave = {
    kind    : 'bubbles',
    sceneId : 's',
    shotId  : 's__page',
    panels: [
      {
        shape: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        framing    : 'medium',
        subjects   : [],
        coversLines: ['s:L1'],
        bubbles    : placed,
      },
    ],
    revision: { scene: 'scene-hash', shots: 'shots-hash' },
  };
  return { ok: true, record: { seq: 1, message: 'Saved.' }, data };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  jest.mocked(api.invoke).mockResolvedValue(undefined as never);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('separates response latency from applying returned coverage', async () => {
  let now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  jest.mocked(exec).mockImplementationOnce(async () => {
    now += 20;
    return success() as Awaited<ReturnType<typeof exec>>;
  });
  const page = editor();
  page.rebuild.mockImplementation(() => {
    now += 4;
  });
  await page.commitBubbles(bubbles(0.7), 'Placing bubble');
  expect(pageTimings.read().at(-1)).toMatchObject({
    kind   : 'pageSave',
    seqs   : [1],
    status : 'ok',
    totalMs: 24,
    phases : { responseMs: 20, refreshMs: 4 },
  });
});

it('separates coverage read latency from rebuilding the page', async () => {
  let now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  jest.mocked(api.invoke).mockImplementation(async (...[channel]) => {
    if (channel === 'command:prewarm') return undefined as never;
    now += 5;
    return coverage as never;
  });
  const page = editor();
  page.rebuild.mockImplementation(() => {
    now += 3;
  });
  await page.load();
  expect(pageTimings.read().at(-1)).toMatchObject({
    kind   : 'pageReload',
    status : 'ok',
    totalMs: 8,
    phases : { coverageMs: 5, refreshMs: 3 },
  });
});

it('keeps drafts visible through overlapping saves and applies narrow results before deferred reload', async () => {
  const first = deferred<ReturnType<typeof success>>();
  const second = deferred<ReturnType<typeof success>>();
  jest
    .mocked(exec)
    .mockReturnValueOnce(first.promise as ReturnType<typeof exec>)
    .mockReturnValueOnce(second.promise as ReturnType<typeof exec>);
  const page = editor();
  const older = bubbles(0.4);
  const savingFirst = page.commitBubbles(older, 'Placing bubble');
  expect(page.bubbleDraft).toBe(older);
  const newer = bubbles(0.8);
  const savingSecond = page.commitBubbles(newer, 'Placing bubble');
  expect(page.bubbleDraft).toBe(newer);
  first.resolve(success(older));
  await savingFirst;
  expect(page.bubbleDraft).toBe(newer);
  const saved = success(newer);
  second.resolve(saved);
  await savingSecond;
  expect(page.bubbleDraft).toBeNull();
  expect(page.data.shots[0]!.panels).toEqual(saved.data.panels);
  expect(page.data.lines).toBe(coverage.lines);
  expect(page.rebuild).toHaveBeenCalledTimes(2);
  expect(api.invoke).not.toHaveBeenCalled();
  // The burst should schedule only one full coverage refresh after the idle delay.
  Object.assign(page, { isConnected: true });
  const reload = jest.fn().mockResolvedValue(undefined);
  page.load = reload;
  jest.advanceTimersByTime(399);
  expect(reload).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(reload).toHaveBeenCalledTimes(1);
});

it.each(['refusal', 'transport error'])('restores saved state after a %s', async (failure) => {
  if (failure === 'refusal')
    jest.mocked(exec).mockResolvedValueOnce({ ok: false, error: 'Failed.' });
  else jest.mocked(exec).mockRejectedValueOnce(new Error('Failed.'));
  const page = editor();
  await page.commitBubbles(bubbles(0.6), 'Placing bubble');
  expect(page.bubbleDraft).toBeNull();
  expect(page.data).toBe(coverage);
  expect(page.bubbleWrites.size).toBe(0);
  expect(page.say).toHaveBeenCalledWith({ tone: 'refused', text: 'Failed.' });
});

it('discards a delayed coverage read after a save returned newer panels', async () => {
  const reading = deferred<SceneCoverage>();
  jest
    .mocked(api.invoke)
    .mockImplementation(
      (...[channel]) =>
        (channel === 'story:coverage' ? reading.promise : Promise.resolve(undefined)) as never,
    );
  const page = editor();
  const loading = page.load();
  const saved = success(bubbles(0.6));
  jest.mocked(exec).mockResolvedValueOnce(saved as Awaited<ReturnType<typeof exec>>);
  await page.commitBubbles(bubbles(0.6), 'Placing bubble');
  reading.resolve(coverage);
  await loading;
  expect(page.data.shots[0]!.panels).toEqual(saved.data.panels);
  expect(page.rebuild).toHaveBeenCalledTimes(1);
});

it('skips its own echo but reloads an external change after the save settles', async () => {
  const pending = deferred<ReturnType<typeof success>>();
  jest.mocked(exec).mockReturnValueOnce(pending.promise as ReturnType<typeof exec>);
  const page = editor();
  const reload = jest.fn().mockResolvedValue(undefined);
  page.load = reload;
  const saving = page.commitBubbles(bubbles(0.7), 'Placing bubble');
  const [id, props] = jest.mocked(exec).mock.calls[0]!;
  page.invalidated({ id, props: props! });
  expect(reload).not.toHaveBeenCalled();
  // Even the same command with a different props object belongs to another caller.
  page.invalidated({ id, props: { ...props } });
  expect(reload).not.toHaveBeenCalled();
  pending.resolve(success());
  await saving;
  expect(page.data.shots[0]!.panels).toEqual(success().data.panels);
  expect(reload).toHaveBeenCalledTimes(1);
});
