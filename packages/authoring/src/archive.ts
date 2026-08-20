/**
 * The archive, where an author's own documents land when they upload them.
 *
 * `archive/` sits at the project root and is deliberately outside every allow-list the agent
 * sweeps. `collectInputFiles` walks `characters/ locations/ scenes/ screenplay/`, entity discovery
 * walks `characters/ locations/ wiki/`, and `openBible` reads `wiki/` — so an uploaded document is
 * invisible to `search`, to `search_bible` and to the project model, while `read_file` still serves
 * it by name. That is the requested policy ("not indexable or searchable unless requested"), and it
 * costs nothing to hold as long as nothing here is added to those lists.
 *
 * Both surfaces reach this module: the desktop's `upload.*` commands and the REPL's `/upload`. A
 * second implementation of where an uploaded file goes would give one project two archives.
 */
import { promises as fs } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { MAX_DOC_BYTES, resolveInWorkspace, workspacePath } from '@vn/store';
import { exists, writeFileAtomic } from '@vn/util';
import type { Workspace } from './workspace.js';

/** The archive's directory name, at the project root. Never under `wiki/` or `vngen/`. */
export const ARCHIVE_DIR = 'archive';

/**
 * The most one uploaded file may weigh. Far above {@link MAX_DOC_BYTES} on purpose. The cap on
 * reading a document is about what fits in a context window; this one is about not copying a disc
 * image into a git repository by accident.
 */
export const MAX_UPLOAD_BYTES = 25_000_000;

/** One archived original: where it came from, where it now is, and whether a tool can read it. */
export interface UploadedFile {
  /** The absolute path the author named. */
  source: string;
  /** Workspace-relative and forward-slashed — the form `read_file` takes. */
  stored: string;
  bytes: number;
  /** True when `read_file` would serve this file's contents today. */
  readable: boolean;
  /** Why it is not readable, in the author's terms. Present only when `readable` is false. */
  note?: string;
}

/** What one upload did. `dir` is empty when nothing landed — no batch directory is created. */
export interface UploadBatch {
  /** Workspace-relative directory holding this batch, e.g. `archive/20260815-142233-notes`. */
  dir: string;
  files: UploadedFile[];
  skipped: { source: string; reason: string }[];
}

/**
 * Formats known to be containers rather than text. Naming them lets the refusal say what would
 * have to exist for the file to be readable, rather than the blank "not a text file" a decode
 * failure gives. A converter writing a text sidecar beside the original is the long-term plan; the
 * original stays untouched either way, so the layout does not have to change for it.
 */
const NO_CONVERTER: Record<string, string> = {
  '.docx': 'Word document',
  '.doc': 'Word document',
  '.odt': 'OpenDocument text',
  '.rtf': 'rich text',
  '.pdf': 'PDF',
  '.zip': 'zip archive',
  '.epub': 'EPUB book',
};

/** Copy the named files into a fresh batch directory under `archive/`, verbatim. */
export async function archiveUpload(
  workspace: Workspace,
  files: string[],
  at: Date = new Date(),
): Promise<UploadBatch> {
  const root = workspace.root;
  const skipped: { source: string; reason: string }[] = [];
  const accepted: { source: string; name: string; bytes: Buffer }[] = [];
  const names = new Set<string>();

  for (const path of files) {
    const source = resolve(path);
    const name = basename(source);
    if (resolveInWorkspace(root, source) !== null) {
      skipped.push({ source, reason: `${name} is already inside the project` });
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(source);
    } catch {
      skipped.push({ source, reason: `no such file: ${source}` });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ source, reason: `${name} is not a regular file` });
      continue;
    }
    if (stat.size > MAX_UPLOAD_BYTES) {
      skipped.push({
        source,
        reason: `${name} is ${mb(stat.size)}, past the ${mb(MAX_UPLOAD_BYTES)} an upload carries`,
      });
      continue;
    }
    // Filenames are preserved, so a flat batch directory cannot hold two `notes.md`. Refusing the
    // second by name is better than renaming it to something the author never wrote down.
    if (names.has(name)) {
      skipped.push({ source, reason: `${name} is in this upload twice` });
      continue;
    }
    names.add(name);
    accepted.push({ source, name, bytes: await fs.readFile(source) });
  }

  if (accepted.length === 0) return { dir: '', files: [], skipped };

  const dir = await batchDir(root, at, accepted[0]!.name);
  const archived: UploadedFile[] = [];
  for (const file of accepted) {
    const abs = join(dir, file.name);
    await writeFileAtomic(abs, file.bytes);
    archived.push({
      source: file.source,
      stored: workspacePath(root, abs),
      bytes: file.bytes.length,
      ...verdict(file.name, file.bytes),
    });
  }
  return { dir: workspacePath(root, dir), files: archived, skipped };
}

/**
 * Whether `read_file` would serve this file. A container format is refused by extension; every
 * other file is decided against the bytes just copied. `readDocFile` refuses on two grounds (past
 * {@link MAX_DOC_BYTES}, or not strict UTF-8) so asking the same two questions here means
 * `readable` cannot claim something the reader will then refuse, whatever the file is called.
 */
function verdict(name: string, bytes: Buffer): { readable: boolean; note?: string } {
  const kind = NO_CONVERTER[extname(name).toLowerCase()];
  if (kind)
    return { readable: false, note: `archived, not yet readable: no converter for ${kind}` };
  if (bytes.length > MAX_DOC_BYTES) {
    return {
      readable: false,
      note: `archived, but ${mb(bytes.length)} is past the ${mb(MAX_DOC_BYTES)} read_file serves`,
    };
  }
  if (!isText(bytes))
    return { readable: false, note: 'archived, not yet readable: not UTF-8 text' };
  return { readable: true };
}

/** The same strict decode `readDocFile` performs, asked as a yes/no. */
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path of the form `archive/<yyyymmdd-hhmmss>-<slug>/` that does not exist yet. The slug is the
 * first file's stem so the directory is recognisable in Explorer, and the stamp is local time,
 * which is the clock the author uploaded by.
 */
async function batchDir(root: string, at: Date, first: string): Promise<string> {
  const base = join(root, ARCHIVE_DIR, `${stamp(at)}-${slug(first)}`);
  let dir = base;
  for (let n = 2; await exists(dir); n++) dir = `${base}-${n}`;
  return dir;
}

function stamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

function slug(name: string): string {
  const stem = basename(name, extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return stem || 'upload';
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * What just arrived, in one sentence. It seeds the first line of the conversation an upload opens
 * and is what the REPL prints. It lives here rather than in either host because a file that was
 * archived but cannot be read is the fact an author most needs told, and a separate wording per
 * surface risks one of them omitting it.
 */
export function describeUpload(batch: UploadBatch): string {
  const parts: string[] = [];
  if (batch.files.length > 0) {
    const names = batch.files.map((f) => `\`${basename(f.stored)}\``).join(', ');
    parts.push(`Uploaded ${count(batch.files.length, 'file')} to \`${batch.dir}/\`: ${names}.`);
    for (const f of batch.files) if (f.note) parts.push(`\`${basename(f.stored)}\` — ${f.note}.`);
  }
  for (const s of batch.skipped) parts.push(`Skipped ${s.reason}.`);
  if (batch.files.length === 0) return parts.join(' ') || 'Nothing was uploaded.';
  const it = batch.files.length === 1 ? 'it' : 'them';
  return `${parts.join(' ')} What should I do with ${it}?`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** One directory of the archive as {@link listArchive} reports it. */
export interface ArchivedBatch {
  /** Workspace-relative, e.g. `archive/20260815-142233-notes`. */
  dir: string;
  files: { path: string; bytes: number }[];
}

/**
 * What the archive holds, newest batch first. This is the only sweep of `archive/` the agent can
 * reach. It names files so the author can be told what arrived and so `read_file` has something to
 * be pointed at, and it never opens one. A missing `archive/` is an empty list.
 */
export async function listArchive(workspace: Workspace): Promise<ArchivedBatch[]> {
  const root = workspace.root;
  const batches = new Map<string, { path: string; bytes: number }[]>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      const key = workspacePath(root, dir);
      const stat = await fs.stat(abs);
      (batches.get(key) ?? batches.set(key, []).get(key)!).push({
        path: workspacePath(root, abs),
        bytes: stat.size,
      });
    }
  };
  await walk(join(root, ARCHIVE_DIR));
  // Batch names are timestamps, so descending by name is newest first without reading a mtime.
  return [...batches.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dir, files]) => ({ dir, files: files.sort((a, b) => a.path.localeCompare(b.path)) }));
}

/**
 * Three or four ways to phrase the next prompt, chosen from the file list alone: extensions and
 * counts, never contents. Reading the documents would cost a model call to produce a sentence the
 * shape of the batch already implies and the author will rewrite anyway.
 */
export function uploadSuggestions(batch: UploadBatch): string[] {
  const readable = batch.files.filter((f) => f.readable);
  if (readable.length === 0) {
    return [
      'Tell me what these hold — I cannot read them yet, so I will work from your description.',
      'Keep them archived for now and remind me they are there when we need them.',
    ];
  }
  const out = ['Summarize these and file them under `wiki/`.'];
  if (readable.some((f) => looksLikeScript(f.stored)))
    out.push('Extract any scenes into `scenes/`, one file each.');
  out.push(
    'Turn the people described here into character sheets.',
    "Read them and tell me what's inconsistent with the story bible.",
  );
  return out;
}

/** Whether a name reads like a script. Decided from the filename; the contents are not read. */
function looksLikeScript(stored: string): boolean {
  const name = basename(stored).toLowerCase();
  return extname(name) === '.fountain' || /scene|chapter|script|\bch\d/.test(name);
}
