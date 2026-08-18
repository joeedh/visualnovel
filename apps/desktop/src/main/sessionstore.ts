/**
 * Persisted desktop UI state: a flat key/value file the shell uses for things that should
 * outlive a launch (panel widths today). Global per install, not per workspace.
 *
 * Not to be confused with `WorkspaceSession` — that is the *backend* session (agent,
 * project model, pipeline). This is only remembered UI state, and it is reachable from a
 * command as `ctx.host.state` for exactly that reason.
 *
 * Multiple app instances may hold the same file open, so writes are: taken under a
 * cross-process lock, merged per key against what is on disk, and written atomically.
 * Two instances setting *different* keys both survive; the same key is last-flush-wins.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { userConfigDir } from '@vn/config';
import { createLogger, retry, writeFileAtomic } from '@vn/util';
import type { SessionValue } from '../shared/ipc.js';

export type { SessionValue } from '../shared/ipc.js';

/** Notified on every `set`, whatever wrote it. */
export type SessionListener = (key: string, value: SessionValue) => void;

const FILE = 'session.json';
const LOCK = 'session.lock';
/** A lock dir older than this belonged to an instance that died holding it. */
const STALE_LOCK_MS = 5_000;
const FLUSH_DEBOUNCE_MS = 200;

const log = createLogger().child({ mod: 'sessionstore' });

/**
 * Where the store lives: `<user config dir>/desktop`, the same home `userConfigDir` gives keys,
 * so the app has one place for user-level state rather than two.
 *
 * It used to be `apps/desktop/.vndesktop`, derived from `__dirname` — which in a packaged app is
 * inside `app.asar`, a *file*, so the store's `mkdir` failed `ENOTDIR` before the first window
 * and the app hung with nothing on screen. A path relative to the bundle is a path relative to
 * a read-only archive, and no amount of care about the rest of packaging survives that.
 *
 * `VN_DESKTOP_HOME` overrides it, which is what lets a test isolate the store; a development run
 * shares the installed app's, because a second home is how a recents list quietly forks in two.
 */
export function resolveSessionDir(): string {
  return process.env.VN_DESKTOP_HOME ?? join(userConfigDir(), 'desktop');
}

/** Read the file, tolerating absence and corruption — a bad file must never block the app. */
async function readFileState(file: string): Promise<Record<string, SessionValue>> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('could not read session state', { file, error: String(err) });
    }
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Record<string, SessionValue>;
  } catch (err) {
    log.warn('discarding corrupt session state', { file, error: String(err) });
    return {};
  }
}

export class SessionStore {
  private readonly file: string;
  private readonly lock: string;
  private cache: Record<string, SessionValue>;
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    dir: string,
    initial: Record<string, SessionValue>,
    private readonly onChange?: SessionListener,
  ) {
    this.file = join(dir, FILE);
    this.lock = join(dir, LOCK);
    this.cache = initial;
  }

  /**
   * Open (and create) the store directory, loading whatever is already on disk. `onChange`
   * fires on every `set` whoever made it — the app hangs the renderer broadcast off it, so
   * a command that writes state moves the UI without having to remember to say so.
   */
  static async open(
    dir: string = resolveSessionDir(),
    onChange?: SessionListener,
  ): Promise<SessionStore> {
    await fs.mkdir(dir, { recursive: true });
    return new SessionStore(dir, await readFileState(join(dir, FILE)), onChange);
  }

  /** Every known key. The renderer takes one of these at startup for a flash-free paint. */
  snapshot(): Record<string, SessionValue> {
    return { ...this.cache };
  }

  get<T extends SessionValue>(key: string, fallback: T): T {
    const value = this.cache[key];
    return value === undefined ? fallback : (value as T);
  }

  /** Record a value in memory, notify the listener, and schedule a debounced flush. */
  set(key: string, value: SessionValue): void {
    this.cache[key] = value;
    this.dirty.add(key);
    this.onChange?.(key, value);
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Write pending keys through to disk. Flushes are serialized within the process. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = this.queue.then(() => this.writeDirty());
    return this.queue;
  }

  /** Flush immediately and stop scheduling; called from the app's `before-quit`. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private async writeDirty(): Promise<void> {
    if (this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    const patch: Record<string, SessionValue> = {};
    for (const key of keys) patch[key] = this.cache[key] as SessionValue;

    try {
      await this.withLock(async () => {
        const merged = { ...(await readFileState(this.file)), ...patch };
        // The lock serializes writers, but a reader holding the target open can still make
        // the rename fail with EPERM on Windows.
        await retry(() => writeFileAtomic(this.file, JSON.stringify(merged, null, 2) + '\n'), {
          attempts: 4,
          baseMs: 25,
        });
        // Adopt the merge, keeping values set while this flush was in flight.
        for (const key of this.dirty) merged[key] = this.cache[key] as SessionValue;
        this.cache = merged;
      });
    } catch (err) {
      log.warn('could not persist session state', { file: this.file, error: String(err) });
      for (const key of keys) if (!this.dirty.has(key)) this.dirty.add(key);
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await fs.rmdir(this.lock).catch(() => {});
    }
  }

  /** `mkdir` is atomic across processes: it fails EEXIST for everyone but the winner. */
  private async acquire(): Promise<void> {
    await retry(
      async () => {
        try {
          await fs.mkdir(this.lock);
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        const held = await fs.stat(this.lock).catch(() => null);
        if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
          log.warn('breaking a stale session lock', { lock: this.lock });
          await fs.rmdir(this.lock).catch(() => {});
        }
        throw new Error(`session store lock is held: ${this.lock}`);
      },
      { attempts: 10, baseMs: 20 },
    );
  }
}
