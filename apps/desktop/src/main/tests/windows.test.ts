/**
 * The window registry, the clamp, the remembered list and the parked requests — everything
 * `src/main/windows.ts` knows, verified without an Electron in sight, which is the whole reason
 * that module is generic over an opaque handle.
 */
import { Pending, WindowList, Windows, clampBounds, type RememberedWindow } from '../windows.js';

/** A stand-in for a `BrowserWindow`: identity is all the registry ever asks of one. */
const handle = (name: string): { name: string } => ({ name });

describe('Windows', () => {
  it('hands out indices from 0 and reuses the lowest free one', () => {
    const windows = new Windows<object>();
    const a = handle('a');
    const b = handle('b');
    const c = handle('c');

    expect(windows.add(a)).toBe(0);
    expect(windows.add(b)).toBe(1);
    expect(windows.add(c)).toBe(2);

    // Closing the middle one and opening another must not renumber the survivors: everything a
    // window remembers is keyed by index, so window 2 must stay window 2.
    windows.remove(1);
    expect(windows.ids()).toEqual([0, 2]);
    expect(windows.add(handle('d'))).toBe(1);
    expect(windows.ids()).toEqual([0, 1, 2]);
  });

  it('resolves a handle back to its index, and an unknown one to undefined', () => {
    const windows = new Windows<object>();
    const a = handle('a');
    const b = handle('b');
    windows.add(a);
    const second = windows.add(b);

    expect(windows.byHandle(b)).toBe(second);
    expect(windows.byHandle(handle('a'))).toBeUndefined();
    expect(windows.byHandle(null)).toBeUndefined();
    expect(windows.byHandle(undefined)).toBeUndefined();
  });

  it('answers an unaddressed act with the most recently focused window', () => {
    const windows = new Windows<object>();
    const a = handle('a');
    const b = handle('b');
    windows.add(a);
    windows.add(b);

    // `add` counts as focus, so the newest window answers until something else takes it.
    expect(windows.focused()).toBe(1);
    windows.touch(0);
    expect(windows.focused()).toBe(0);
    expect(windows.focusedHandle()).toBe(a);

    // A closed window must drop out of the recency list, not merely out of the map. Otherwise
    // the app keeps addressing a window that is gone.
    windows.remove(0);
    expect(windows.focused()).toBe(1);
    windows.remove(1);
    expect(windows.focused()).toBeUndefined();
    expect(windows.focusedHandle()).toBeUndefined();
  });
});

describe('clampBounds', () => {
  const left = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const right = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };

  it('leaves a window that overlaps any display exactly where it was', () => {
    const hanging = { x: 1800, y: 900, width: 400, height: 400 };
    expect(clampBounds(hanging, [left])).toEqual(hanging);
  });

  it('centres a window on the nearest display when it touches none', () => {
    // The second monitor is gone: a window that lived on it is nowhere the author can reach.
    const orphan = { x: 2400, y: 200, width: 800, height: 600 };
    expect(clampBounds(orphan, [left])).toEqual({ x: 560, y: 240, width: 800, height: 600 });
  });

  it('shrinks a window too big for the display it lands on', () => {
    const huge = { x: -5000, y: -5000, width: 4000, height: 3000 };
    expect(clampBounds(huge, [left, right])).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('is a no-op with no displays at all, rather than moving a window to nowhere', () => {
    const somewhere = { x: 10, y: 20, width: 30, height: 40 };
    expect(clampBounds(somewhere, [])).toEqual(somewhere);
  });
});

describe('WindowList', () => {
  const at = (id: number): RememberedWindow => ({
    id,
    bounds: { x: id, y: id, width: 100, height: 100 },
  });

  it('rewrites on every change until it is frozen', () => {
    const writes: RememberedWindow[][] = [];
    const list = new WindowList((windows) => writes.push(windows));

    list.rewrite([at(0), at(1)]);
    list.rewrite([at(0)]);
    expect(writes).toEqual([[at(0), at(1)], [at(0)]]);
    expect(list.isFrozen).toBe(false);
  });

  it('freezes the open set at quit, so the cascade of closes cannot erase it', () => {
    const writes: RememberedWindow[][] = [];
    const list = new WindowList((windows) => writes.push(windows));

    list.freeze([at(0), at(1)]);
    // Every window closing on the way out would otherwise rewrite the list down to nothing.
    list.rewrite([at(0)]);
    list.rewrite([]);
    list.freeze([]);

    expect(writes).toEqual([[at(0), at(1)]]);
    expect(list.isFrozen).toBe(true);
  });
});

describe('Pending', () => {
  it('resolves the request the answer names, and ignores an id it does not know', () => {
    const pending = new Pending<string>('');
    const ids: number[] = [];
    const first = pending.ask((id) => ids.push(id));
    const second = pending.ask((id) => ids.push(id));

    pending.answer(999, 'nobody asked this');
    pending.answer(ids[1]!, 'second');
    pending.answer(ids[0]!, 'first');
    expect(pending.outstanding).toBe(0);
    return Promise.all([first, second]).then((answers) => {
      expect(answers).toEqual(['first', 'second']);
    });
  });

  it('abandons only the closed window’s requests', async () => {
    const pending = new Pending<boolean>(false);
    let mineId = 0;
    const mine = pending.ask((id) => (mineId = id), 0);
    const theirs = pending.ask(() => {}, 1);

    pending.by(0);
    expect(await mine).toBe(false);
    expect(pending.outstanding).toBe(1);

    // The window that closed is gone, so its id must not resolve anything a second time.
    pending.answer(mineId, true);
    expect(pending.outstanding).toBe(1);

    pending.abandon();
    expect(await theirs).toBe(false);
    expect(pending.outstanding).toBe(0);
  });

  it('answers with the abandoned value, which is a denial rather than silence', () => {
    expect(new Pending<{ approved: boolean }>({ approved: false }).abandonedValue).toEqual({
      approved: false,
    });
  });
});
