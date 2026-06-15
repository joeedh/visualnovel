import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/** Ensure a directory exists (recursive, idempotent). */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Atomic write: write to a temp sibling then rename, so a crash never leaves a
 * half-written file (report §10 crash-safety).
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const suffix = createHash('sha1')
    .update(path)
    .update(String(data.length))
    .digest('hex')
    .slice(0, 8);
  const tmp = `${path}.tmp-${suffix}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, path);
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
