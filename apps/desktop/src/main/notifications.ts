/**
 * The notification log: one append-only JSONL file per project at
 * `vngen/state/notifications.jsonl`, holding every event the app has reported.
 *
 * It lives in the desktop app rather than `@vn/store` for the reason `threads.ts` gives: a
 * notification is not one of a *project's authored files*, so it does not belong in the package
 * that models those — even though `vngen/state/` is where this project keeps its append-only logs
 * and the path itself is a `ProjectPaths` getter. Nothing here assumes the desktop.
 *
 * Two contracts are owned by this module and by nothing else:
 *
 * 1. **Flags are patched in place.** `"r"` (read) and `"h"` (hidden) are single ASCII digits in
 *    each line's head, so marking one read is a one-byte write at a computed offset rather than a
 *    rewrite of the file or another line appended to it.
 * 2. **The file is union-merged** (`merge=union` in the project's `.gitattributes`), so a line
 *    whose flags both sides changed comes back twice. The reader dedupes by `id` and ORs the
 *    flags: read and hidden are monotonic, so the set bit is always the newer truth.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { appendJsonl } from '@vn/util';
import {
  migrateNotification,
  NOTIFICATION_VERSION,
  type Notification,
  type NotificationInput,
} from '@vn/types';

const LF = 0x0a;
const CR = 0x0d;
const ZERO = 0x30;
const ONE = 0x31;

/** One app launch, so a merged log can be split back into the sessions that wrote it. */
export const SESSION_ID = newSessionId();

let posted = 0;

function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

/**
 * Random-suffixed, because two launches in the same second are ordinary — closing the app and
 * reopening it, or a second window — and a session id that collides makes the debugging tooling
 * this field exists for report one session where there were two.
 */
function newSessionId(at = new Date()): string {
  return `${stamp(at)}-${randomBytes(2).toString('hex')}`;
}

/**
 * Ids are `<session>-<n>`: unique across sessions without a lookup, and monotonic within one.
 * Nothing sorts by id — `at` does that — but ties break on it, so it has to be stable.
 */
function nextId(): string {
  return `${SESSION_ID}-${String(posted++).padStart(4, '0')}`;
}

/**
 * Build a line. **The key order here is load-bearing**: `JSON.stringify` preserves insertion
 * order, and `v`/`r`/`h` must land in the line's pure-ASCII head where `patchFlag` can find them
 * ahead of any authored text. A test pins it.
 */
export function buildNotification(
  input: NotificationInput,
  now = new Date(),
  session = SESSION_ID,
): Notification {
  return {
    v: NOTIFICATION_VERSION,
    r: 0,
    h: 0,
    id: nextId(),
    at: now.toISOString(),
    session,
    category: input.category,
    level: input.level ?? 'info',
    source: input.source ?? 'main',
    message: input.message,
    ...(input.link ? { link: input.link } : {}),
  };
}

/** Where each line starts and ends, in **bytes**. Tolerates `\r\n` and a missing final newline. */
function lineSpans(buf: Buffer): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i !== buf.length && buf[i] !== LF) continue;
    let end = i;
    if (end > start && buf[end - 1] === CR) end--;
    if (end > start) spans.push({ start, end });
    start = i + 1;
  }
  return spans;
}

/**
 * Every notification the file holds, deduped and sorted oldest-first. A line that will not parse
 * is skipped rather than thrown over — see `migrateNotification` for why that is the right trade
 * here. Missing file → `[]`.
 */
export async function readNotifications(file: string): Promise<Notification[]> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const byId = new Map<string, Notification>();
  for (const { start, end } of lineSpans(buf)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8', start, end));
    } catch {
      continue; // A line that will not parse is a line that was never finished being written.
    }
    const note = migrateNotification(parsed);
    if (!note) continue;

    const seen = byId.get(note.id);
    // OR, not last-wins: union merge gives no ordering between the two copies, and both flags
    // only ever go 0 → 1, so the set bit is the later of the two whichever order they arrived in.
    if (seen) {
      seen.r = (seen.r || note.r) as 0 | 1;
      seen.h = (seen.h || note.h) as 0 | 1;
    } else {
      byId.set(note.id, note);
    }
  }

  return [...byId.values()].sort((a, b) => (a.at === b.at ? cmp(a.id, b.id) : cmp(a.at, b.at)));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Append one line. Not `writeFileAtomic` — that is a whole-file rewrite of an append-only log. */
export async function appendNotification(file: string, note: Notification): Promise<void> {
  await appendJsonl(file, note);
}

/**
 * Flip `r` and/or `h` on every line carrying `id`, one byte per flag, in place.
 *
 * **Byte offsets, never character offsets.** Decoding the file to a string first would work on
 * the patched line — its head is ASCII — and be wrong about *where that line begins*: a string
 * index runs short by one for every extra byte of every multi-byte character above it, and this
 * app's own messages are full of them (`⟲`, `…`, em-dashes). One such character in an earlier
 * line and the write lands inside somebody else's message.
 *
 * Every matching line is patched, not just the first: a union merge leaves duplicates behind, and
 * flagging all of them is what keeps the reader's OR from resurrecting the old value.
 *
 * Returns false when nothing matched, or when a matching line's head is not the digit this module
 * writes — a line it did not author is left exactly as it found it.
 */
export async function setNotificationFlags(
  file: string,
  id: string,
  flags: { read?: boolean; hidden?: boolean },
): Promise<boolean> {
  const wanted: [string, 0 | 1][] = [];
  if (flags.read !== undefined) wanted.push(['"r":', flags.read ? 1 : 0]);
  if (flags.hidden !== undefined) wanted.push(['"h":', flags.hidden ? 1 : 0]);
  if (wanted.length === 0) return false;

  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const needle = `"id":${JSON.stringify(id)}`;
  const writes: { offset: number; byte: number }[] = [];
  for (const { start, end } of lineSpans(buf)) {
    const line = buf.subarray(start, end);
    if (!line.includes(needle)) continue;
    for (const [key, value] of wanted) {
      const at = line.indexOf(key);
      if (at < 0) continue;
      const offset = start + at + key.length;
      if (buf[offset] !== ZERO && buf[offset] !== ONE) continue;
      writes.push({ offset, byte: value ? ONE : ZERO });
    }
  }
  if (writes.length === 0) return false;

  const handle = await fs.open(file, 'r+');
  try {
    for (const { offset, byte } of writes) {
      await handle.write(Buffer.from([byte]), 0, 1, offset);
    }
  } finally {
    await handle.close();
  }
  return true;
}

/** Delete everything, permanently. The file stays, so git sees a truncation, not a deletion. */
export async function truncateNotifications(file: string): Promise<void> {
  await fs.writeFile(file, '');
}

export interface NotificationDeps {
  /**
   * The log of the project that is open **now**. Resolved per call and never captured: a captured
   * root would write into the directory `workspace.create` is about to check for emptiness, and
   * creating a project would start failing. `undefined` while no project is open.
   */
  file(): string | undefined;
  /**
   * Tell the renderer the log moved, so the bell and an open dialog update live. Called with the
   * new notification when one was posted, and with nothing when only flags changed — the count is
   * stale either way, but a flag change is not news and must not be said a second time on screen.
   */
  push(note?: Notification): void;
}

/**
 * The one place a notification is posted from. Everything — a command outcome, a finished render,
 * a renderer-local notice — arrives here, so there is one log and one live event.
 */
export class NotificationHub {
  /**
   * Posted before the app was ready to write. Held rather than written because `openRepos()`
   * checkpoints the worktree as "Changes made outside the app": anything that reaches
   * `vngen/state` before that point earns that commit subject on every single launch.
   */
  private pending: Notification[] = [];
  private ready = false;

  constructor(private readonly deps: NotificationDeps) {}

  /** The workspace is open and its checkpoint has been taken. Write what was held. */
  async open(): Promise<void> {
    this.ready = true;
    const held = this.pending;
    this.pending = [];
    const file = this.deps.file();
    if (!file) return;
    for (const note of held) await appendNotification(file, note);
  }

  /** A workspace switch is starting: hold again until the next project's checkpoint is taken. */
  suspend(): void {
    this.ready = false;
    this.pending = [];
  }

  /** File it, then show it. The event fires either way — a held note is still news. */
  async post(input: NotificationInput, now = new Date()): Promise<Notification> {
    const note = buildNotification(input, now);
    const file = this.deps.file();
    if (this.ready && file) await appendNotification(file, note);
    else this.pending.push(note);
    this.deps.push(note);
    return note;
  }

  /** Everything, oldest first — including anything still held, which the log cannot answer for. */
  async list(): Promise<Notification[]> {
    const file = this.deps.file();
    const stored = file ? await readNotifications(file) : [];
    return [...stored, ...this.pending];
  }

  /**
   * Announced, not just written: the dialog refetches after its own `notify.*` command, but the
   * palette, the agent and CDP reach the same commands, and a bell left counting an already-read
   * notification is wrong however the flag moved.
   */
  async setFlags(id: string, flags: { read?: boolean; hidden?: boolean }): Promise<boolean> {
    const moved = await this.writeFlags(id, flags);
    if (moved) this.deps.push();
    return moved;
  }

  private async writeFlags(
    id: string,
    flags: { read?: boolean; hidden?: boolean },
  ): Promise<boolean> {
    for (const note of this.pending) {
      if (note.id !== id) continue;
      if (flags.read !== undefined) note.r = flags.read ? 1 : 0;
      if (flags.hidden !== undefined) note.h = flags.hidden ? 1 : 0;
      return true;
    }
    const file = this.deps.file();
    return file ? setNotificationFlags(file, id, flags) : false;
  }

  /** Hide a set of ids in one act — what "Clear" is, over exactly what the dialog drew. */
  async hideAll(ids: readonly string[]): Promise<number> {
    let hidden = 0;
    for (const id of ids) if (await this.writeFlags(id, { hidden: true })) hidden++;
    if (hidden > 0) this.deps.push();
    return hidden;
  }

  async purge(): Promise<void> {
    this.pending = [];
    const file = this.deps.file();
    if (file) await truncateNotifications(file);
    this.deps.push();
  }
}

let hub: NotificationHub | undefined;

/**
 * Wire the hub to the app. Called once from main; a module singleton rather than something
 * threaded through, so `session.ts` can post without importing `index.ts` back.
 */
export function installNotifications(deps: NotificationDeps): NotificationHub {
  hub = new NotificationHub(deps);
  return hub;
}

/**
 * The hub, or a dormant one that holds everything and shows nothing. Tests and the CLI-shaped
 * paths through this module never install one, and a notification is not worth a crash.
 */
export function notifications(): NotificationHub {
  if (!hub) hub = new NotificationHub({ file: () => undefined, push: () => {} });
  return hub;
}

/** Post one notification. The shorthand every call site outside this module uses. */
export function notify(input: NotificationInput): Promise<Notification> {
  return notifications().post(input);
}
