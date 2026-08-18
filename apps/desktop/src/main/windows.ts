/**
 * The window registry: what main knows about the several renderers it is now talking to.
 *
 * A window is a **view**, not a document — one main process, one `WorkspaceSession`, one
 * `CommandStack`, one project, and N windows onto it. So what lives here is only the address
 * book: which windows exist, which one asked for something, which one to answer when nobody
 * asked, and where each one was on screen last time.
 *
 * **This module does not import `electron`**, and that is a requirement rather than an
 * accident: `src/main/index.ts` is the only module under `src/main/` that may, because the
 * `@vn/desktop` jest project is node-only and has no `electron` mapper. Everything here is
 * therefore generic over an opaque window handle, and `index.ts` instantiates it as
 * `Windows<BrowserWindow>`.
 */

/** A window's index within its workspace. Stable across a close and a reopen — see `add`. */
export type WindowId = number;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Just enough of a display to clamp against; `electron`'s `Display` structurally satisfies it. */
export interface DisplayLike {
  bounds: WindowBounds;
}

export interface WindowEntry<W> {
  id: WindowId;
  handle: W;
}

export class Windows<W> {
  private readonly entries = new Map<WindowId, W>();
  /** Most recently focused last. Only ever holds live ids. */
  private readonly recency: WindowId[] = [];

  /**
   * Register a window at the **lowest free index**. Reuse is the point: a window's remembered
   * layout, selection and template are keyed by index, so a closed-and-reopened window comes
   * back into its own arrangement rather than a default screen.
   */
  add(handle: W): WindowId {
    let id = 0;
    while (this.entries.has(id)) id++;
    this.entries.set(id, handle);
    this.touch(id);
    return id;
  }

  remove(id: WindowId): void {
    this.entries.delete(id);
    const at = this.recency.indexOf(id);
    if (at >= 0) this.recency.splice(at, 1);
  }

  get(id: WindowId): W | undefined {
    return this.entries.get(id);
  }

  has(id: WindowId): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Ascending by index, which is the order the title's ` (n)` suffix and the saved list use. */
  all(): WindowEntry<W>[] {
    return [...this.entries.entries()]
      .map(([id, handle]) => ({ id, handle }))
      .sort((a, b) => a.id - b.id);
  }

  ids(): WindowId[] {
    return this.all().map((entry) => entry.id);
  }

  /**
   * Which window is this handle? `index.ts` resolves an IPC `event.sender` to its own window
   * first, so the comparison here stays a plain identity check and `electron` stays out.
   */
  byHandle(handle: W | null | undefined): WindowId | undefined {
    if (!handle) return undefined;
    for (const [id, candidate] of this.entries) if (candidate === handle) return id;
    return undefined;
  }

  /** Record that `id` took focus. Called from the window's own `focus` event. */
  touch(id: WindowId): void {
    const at = this.recency.indexOf(id);
    if (at >= 0) this.recency.splice(at, 1);
    this.recency.push(id);
  }

  /**
   * Who answers when nobody asked. The focused window, and — since a window may be behind the
   * author's browser rather than gone — the most recently focused one when nothing has focus.
   */
  focused(): WindowId | undefined {
    return this.recency[this.recency.length - 1];
  }

  /** The focused window's handle, or the most recently focused one's. */
  focusedHandle(): W | undefined {
    const id = this.focused();
    return id === undefined ? undefined : this.entries.get(id);
  }
}

/**
 * Pull `bounds` back onto the display set. A monitor that was there last launch may not be now,
 * and a window restored entirely off-screen is indistinguishable from one that never opened.
 *
 * Overlap, not containment: a window hanging off the right edge of a monitor it is mostly on is
 * where the author left it, so it is left alone. Only a window touching nothing is moved, onto
 * the display whose centre is nearest, and shrunk if it does not fit there.
 */
export function clampBounds(bounds: WindowBounds, displays: DisplayLike[]): WindowBounds {
  if (displays.length === 0) return bounds;
  const overlaps = (a: WindowBounds, b: WindowBounds): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  if (displays.some((display) => overlaps(bounds, display.bounds))) return bounds;

  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const distance = (d: DisplayLike): number => {
    const dx = d.bounds.x + d.bounds.width / 2 - centre.x;
    const dy = d.bounds.y + d.bounds.height / 2 - centre.y;
    return dx * dx + dy * dy;
  };
  const nearest = displays.reduce((best, d) => (distance(d) < distance(best) ? d : best));
  const width = Math.min(bounds.width, nearest.bounds.width);
  const height = Math.min(bounds.height, nearest.bounds.height);
  return {
    width,
    height,
    x: nearest.bounds.x + Math.max(0, Math.round((nearest.bounds.width - width) / 2)),
    y: nearest.bounds.y + Math.max(0, Math.round((nearest.bounds.height - height) / 2)),
  };
}

/** One remembered window: which index it was, and where. */
export interface RememberedWindow {
  id: WindowId;
  bounds: WindowBounds;
}

/**
 * The remembered arrangement of a workspace's windows, rewritten from the live set.
 *
 * Closing a window deliberately means it does not come back, so the list is rewritten on every
 * move, resize and close. A **quit** closes every window in a cascade, which would otherwise
 * rewrite the list down to nothing and lose the whole arrangement — so `freeze()` at
 * `before-quit` snapshots the open set and stops writing for the rest of the process.
 *
 * The per-window `…window.<n>.*` keys are left alone either way: they are cheap, and they are
 * what makes index reuse worth having.
 */
export class WindowList {
  private frozen = false;

  constructor(private readonly write: (windows: RememberedWindow[]) => void) {}

  rewrite(windows: RememberedWindow[]): void {
    if (this.frozen) return;
    this.write(windows);
  }

  /** Snapshot the open set, then stop writing. Idempotent: a second quit signal changes nothing. */
  freeze(windows: RememberedWindow[]): void {
    if (this.frozen) return;
    this.write(windows);
    this.frozen = true;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }
}

/**
 * A request main is blocked on until a renderer answers it. Plan approval, a clarifying question
 * and an always-confirm tool are the same shape, so they share one: an id, the promise the agent
 * turn is parked on, the window it went to, and the answer {@link abandon} gives when nobody is
 * left to ask — a promise nothing will ever resolve hangs the agent for the life of the process.
 *
 * The window matters now. With one window, "that window closed" and "there is nobody left" were
 * the same fact; with four, ending every parked turn because one window closed would be a bug,
 * so a close abandons only {@link by} its own.
 */
export class Pending<T> {
  private readonly waiting = new Map<number, { resolve: (value: T) => void; window?: WindowId }>();
  private seq = 0;

  constructor(private readonly abandoned: T) {}

  /** What a request answers with when there is nobody to ask — a denial, or silence. */
  get abandonedValue(): T {
    return this.abandoned;
  }

  ask(send: (id: number) => void, window?: WindowId): Promise<T> {
    return new Promise<T>((resolve) => {
      const id = ++this.seq;
      this.waiting.set(id, { resolve, window });
      send(id);
    });
  }

  answer(id: number, value: T): void {
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    entry.resolve(value);
  }

  /** Nobody is left to ask at all — a workspace torn down, the last window gone. */
  abandon(): void {
    const waiters = [...this.waiting.values()];
    this.waiting.clear();
    for (const entry of waiters) entry.resolve(this.abandoned);
  }

  /** One window closed: end the turns parked on *it*, and leave every other window's alone. */
  by(window: WindowId): void {
    for (const [id, entry] of [...this.waiting]) {
      if (entry.window !== window) continue;
      this.waiting.delete(id);
      entry.resolve(this.abandoned);
    }
  }

  /** How many requests are outstanding, for tests and for a shutdown that must leave none. */
  get outstanding(): number {
    return this.waiting.size;
  }
}
