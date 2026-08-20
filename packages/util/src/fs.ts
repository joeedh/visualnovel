import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/** Ensure a directory exists (recursive, idempotent). */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Atomic write: write to a temp sibling then rename, so a crash never leaves a
 * half-written file (report §10 crash-safety).
 *
 * The suffix is **random** rather than derived from the path and the data's length: two writers
 * of the same path with same-length data shared one temp file and raced. And the temp is unlinked
 * in a `finally`, because a failed rename otherwise leaves a `.tmp-…` sibling in `scenes/`, where
 * it is neither a scene nor invisible. The unlink's own error is swallowed: a cleanup that fails
 * must not mask the failure that caused it.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tmp, data);
    await renameWithRetry(tmp, path);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * On Windows the destination may be held open for a moment by something that scans files as
 * they change — antivirus, an indexer, an editor's watcher — and the rename then fails EPERM
 * (or EACCES/EBUSY) even though nothing is wrong with either path. The lock is released in
 * milliseconds, so a failed rename is retried briefly before it is allowed to be an error.
 */
const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_BASE_DELAY_MS = 10;

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RENAME_RETRYABLE.has(code) || attempt >= RENAME_ATTEMPTS) throw err;
      await new Promise((resolve) =>
        setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** (attempt - 1)),
      );
    }
  }
}

/** Append one JSON record as a line to a JSONL file, creating it if needed. */
export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await fs.appendFile(path, JSON.stringify(record) + '\n');
}

/** Read a JSONL file into an array of parsed records; missing file → []. */
export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Read a UTF-8 text file. */
export async function readText(path: string): Promise<string> {
  return fs.readFile(path, 'utf8');
}

/** True if a path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export { join };
