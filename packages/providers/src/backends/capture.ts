/**
 * Keeping an outbound request so it can be read after it failed.
 *
 * A conversation request is the one thing in this package that cannot be reconstructed from what
 * comes back: the body is assembled from a transcript the loop owns, sent, and forgotten. When the
 * API rejects it by position ("messages.1.content.0: unexpected `tool_use_id`"), the position is
 * only meaningful against the body, so the body is kept here.
 *
 * There are two destinations. A ring in memory is always on, bounded by bytes and by count, oldest
 * evicted; it never leaves the process on its own, and its one reader is the debug agent, on the
 * author's own key, only when the author ticks the box that says so
 * (`docs/plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it`). Files on disk
 * are off unless `VN_DUMP_REQUESTS` names a directory, and deliberately not wired to a log level:
 * the body carries the whole conversation, which is the author's fiction and their file contents,
 * and a verbosity flag should not start writing that out.
 *
 * Neither destination ever carries the API key, which rides on the client rather than the payload.
 *
 * The body is written before the call rather than after it, because the failures worth capturing
 * include the ones that never return. What went wrong is recorded beside it afterwards.
 */
import { Buffer } from 'node:buffer';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

/** Where to write files, or nothing at all. Read per call, so it can be turned on mid-session. */
function dumpDir(): string | undefined {
  const dir = process.env.VN_DUMP_REQUESTS;
  return dir && dir.trim() !== '' ? dir : undefined;
}

/** What the ring holds before it starts evicting. Both caps apply, and either can trigger first. */
const DEFAULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_COUNT = 64;

/** An env override, or the default. A value that is not a positive number is ignored. */
function capFrom(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** What is known about a captured request without reading a byte of it. */
export interface CapturedHeader {
  seq: number;
  /** Which call site captured it — `convo` for the assembled conversation body. */
  label: string;
  at: string;
  bytes: number;
  /**
   * True when the body alone exceeded the whole byte cap and was discarded. The header is kept
   * anyway, so the size of what was sent is still on record.
   */
  dropped: boolean;
  /** The failure, when the call came back with one. */
  error?: string;
}

interface Entry extends CapturedHeader {
  json?: string;
}

/**
 * A frozen view of the ring.
 *
 * The debug agent takes minutes and many calls to read one of these, and a live ring would evict
 * entries (possibly the one it was opened to read) between the listing and the read.
 */
export interface CaptureSnapshot {
  headers(): CapturedHeader[];
  body(seq: number): string | undefined;
}

const ring: Entry[] = [];
let held = 0;

/** Counts calls within this process. The pid is in the filename too, so two runs cannot collide. */
let seq = 0;

/** Drop the oldest until both caps are satisfied again. */
function evict(): void {
  const bytes = capFrom('VN_CAPTURE_BYTES', DEFAULT_BYTES);
  const count = capFrom('VN_CAPTURE_COUNT', DEFAULT_COUNT);
  while (ring.length > 0 && (held > bytes || ring.length > count)) {
    const [gone] = ring.splice(0, 1);
    if (gone?.json) held -= gone.bytes;
  }
}

/** A capture in progress: which entry it became, and somewhere to record how the call came out. */
export interface Capture {
  /**
   * The entry's number, or `0` for a call that was not recorded. Callers keep it so they can say
   * afterwards which requests a failed turn was made of.
   */
  readonly seq: number;
  /** Record the failure, in the ring and — when the dump is on — beside the file. */
  failed(err: unknown): Promise<void>;
}

export interface CaptureOptions {
  /**
   * Set false to capture nothing at all. The debug agent's own model runs with this off: an
   * analysis that recorded itself would evict the very bodies it was opened to read, and would
   * then find its own prompts in the ring as though they were the author's.
   */
  record?: boolean;
}

const IGNORED: Capture = { seq: 0, failed: async () => {} };

/**
 * Keeps `body` and hands back somewhere to file the failure.
 *
 * Every filesystem error is swallowed to a warning, because a diagnostic that breaks the thing it
 * was turned on to diagnose is worse than no diagnostic, and an unwritable dump directory is the
 * author's typo rather than a reason to fail the turn.
 */
export async function captureRequest(
  label: string,
  body: Record<string, unknown>,
  opts: CaptureOptions = {},
): Promise<Capture> {
  if (opts.record === false) return IGNORED;

  // Serialized once and kept as a string. The agent loop mutates the turn arrays it owns, so a
  // retained object would drift away from what was actually sent.
  const json = `${JSON.stringify(body, null, 2)}\n`;
  const bytes = Buffer.byteLength(json, 'utf8');
  const entry: Entry = {
    seq: ++seq,
    label,
    at: new Date().toISOString(),
    bytes,
    dropped: bytes > capFrom('VN_CAPTURE_BYTES', DEFAULT_BYTES),
  };
  // A body larger than the whole cap keeps its header and loses its content — otherwise eviction
  // would empty the ring trying to make room for something that can never fit.
  if (!entry.dropped) {
    entry.json = json;
    held += bytes;
  }
  ring.push(entry);
  evict();

  const dir = dumpDir();
  const name = `${label}-${process.pid}-${String(entry.seq).padStart(3, '0')}`;
  if (dir) {
    const path = join(dir, `${name}.json`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, json, 'utf8');
    } catch (err) {
      console.warn(`[vn] could not write ${path}: ${String(err)}`);
    }
  }

  return {
    seq: entry.seq,
    failed: async (err: unknown) => {
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      entry.error = text;
      if (!dir) return;
      try {
        await appendFile(join(dir, `${name}.error.txt`), `${text}\n`, 'utf8');
      } catch (writeErr) {
        console.warn(`[vn] could not write ${name}.error.txt: ${String(writeErr)}`);
      }
    },
  };
}

/** What the ring holds, newest last. Headers only — nothing here reads a body. */
export function capturedRequests(): CapturedHeader[] {
  return ring.map(({ json: _json, ...header }) => ({ ...header }));
}

/** One body, or `undefined` for a seq that was evicted, dropped or never existed. */
export function capturedRequest(seq: number): string | undefined {
  return ring.find((entry) => entry.seq === seq)?.json;
}

/**
 * Freeze what the ring holds now. The copy is shallow over immutable strings, so it costs a list
 * rather than the bodies — and nothing that happens to the ring afterwards can reach it.
 */
export function captureSnapshot(): CaptureSnapshot {
  const taken = ring.map((entry) => ({ ...entry }));
  return {
    headers: () => taken.map(({ json: _json, ...header }) => ({ ...header })),
    body: (seq: number) => taken.find((entry) => entry.seq === seq)?.json,
  };
}

/**
 * Forget everything. The ring is process-wide and a workspace is not, so closing one must not
 * leave its conversation in memory for whatever opens next.
 */
export function clearCaptures(): void {
  ring.length = 0;
  held = 0;
}
