/**
 * A workspace text document: the bounded read, the bounded write, and the refusals every
 * whole-file surface needs. Two callers share it, the agent's `read_file`/`write_file` and the
 * desktop's `doc.*` commands, so "outside the workspace" and "`scenes/` has its own writer" are
 * answered once here instead of twice in ways that drift.
 *
 * This module does not know whether the document is a valid entity sheet. That check needs
 * `@vn/model`, which is this package's sibling, so a caller that cares runs it. A schema failure
 * is a diagnostic beside a saved file rather than a refusal.
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseFrontMatter, type FrontMatterDoc } from '@vn/parse';
import { ENTITY_TAG_KEY, ENTITY_TAGS, type EntityTag } from '@vn/types';
import { sha256, writeFileAtomic } from '@vn/util';

/**
 * The most a document surface will carry. This is a surface bound rather than a storage limit: past
 * it, a file is no longer something a human edits in a text box, and shipping it over IPC costs
 * more than refusing it.
 */
export const MAX_DOC_BYTES = 1_000_000;

/** Resolve a workspace-relative or absolute path, rejecting anything outside `root`. */
export function resolveInWorkspace(root: string, path: string): string | null {
  const abs = resolve(root, path);
  const rel = relative(resolve(root), abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? abs : null;
}

/** Workspace-relative and forward-slashed, the form every document API uses. */
export function workspacePath(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

/**
 * The validated writer that owns a path, or null when no writer owns it. A chunk written whole is
 * unvalidated, so it can carry duplicate line ids, a lost heading, or a scene id that no longer
 * matches the filename. Every scene writer checks each of those before it writes.
 */
export function guardedDir(path: string): 'scenes' | null {
  return path.replace(/\\/g, '/').split('/')[0] === 'scenes' ? 'scenes' : null;
}

/**
 * What every document surface answers for the project's own key directory. Worded to match
 * `@vn/agentreport`'s source reader, which already refuses the same directory.
 */
export const SECRETS_REFUSAL = 'keys/ holds API credentials and is never readable.';

/**
 * True for a workspace-relative path inside `keys/`. Compared case-insensitively, because
 * Windows resolves `Keys/` to the same directory and refusing a differently-cased directory on
 * a case-sensitive filesystem costs nothing.
 */
export function inSecretsDir(path: string): boolean {
  return path.replace(/\\/g, '/').split('/')[0]?.toLowerCase() === 'keys';
}

/** One document as read: its bytes decoded, and the hash a later write carries back. */
export interface DocFile {
  /** Workspace-relative, forward-slashed. */
  path: string;
  text: string;
  /** sha256 of the bytes on disk — the token a save presents to prove what it edited. */
  hash: string;
  bytes: number;
}

export type DocResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function tooBig(path: string, bytes: number): string {
  const mb = (bytes / 1_000_000).toFixed(1);
  return `${path} is ${mb} MB, past the ${MAX_DOC_BYTES / 1_000_000} MB a document surface reads`;
}

/** Decode UTF-8 strictly; a file that is not text is refused rather than shown as mojibake. */
function decode(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Read one workspace text file: bounded, text-only, and workspace-relative in and out. The size
 * bound is the reason this exists as a function rather than a `readText` call — an unbounded read
 * behind an IPC channel is a way to hang the app with one stray file.
 */
export async function readDocFile(
  root: string,
  path: string,
): Promise<DocResult<{ file: DocFile }>> {
  const abs = resolveInWorkspace(root, path);
  if (!abs) return refuse(`path "${path}" is outside the workspace`);
  const rel = workspacePath(root, abs);
  // Before the stat, so the refusal is the same whether or not a key file happens to be there.
  if (inSecretsDir(rel)) return refuse(SECRETS_REFUSAL);

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return refuse(`no such file: ${rel}`);
  }
  if (stat.isDirectory()) return refuse(`${rel} is a directory, not a document`);
  if (stat.size > MAX_DOC_BYTES) return refuse(tooBig(rel, stat.size));

  const bytes = await fs.readFile(abs);
  const text = decode(bytes);
  if (text === null) return refuse(`${rel} is not a text file`);
  return { ok: true, file: { path: rel, text, hash: sha256(bytes), bytes: bytes.length } };
}

/** The `type:` tag a document states, or undefined when it states none. */
export function taggedKind(data: Record<string, unknown>): EntityTag | undefined {
  const tag = data[ENTITY_TAG_KEY];
  return tag === ENTITY_TAGS.character || tag === ENTITY_TAGS.location ? tag : undefined;
}

/**
 * The kind a conventional location on disk implies. Discovery takes a sheet's kind from its
 * directory and treats a `type:` tag there as a conflict rather than an override, so a surface
 * validating an incoming save asks the question the same way round. Asking it the other way round
 * would skip the check on the one sheet the whole project is built on.
 */
export function conventionalKind(path: string): EntityTag | undefined {
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length === 3 && parts[0] === 'characters' && parts[2] === 'character.md') {
    return ENTITY_TAGS.character;
  }
  if (parts.length === 2 && parts[0] === 'locations' && parts[1]!.endsWith('.md')) {
    return ENTITY_TAGS.location;
  }
  return undefined;
}

/** What a save would do: the file it lands in, the new hash, and the sentence a check reports. */
export interface DocWritePlan {
  file: string;
  path: string;
  hash: string;
  bytes: number;
  /** The incoming text's front-matter, already parsed — the caller's entity check reuses it. */
  doc: FrontMatterDoc;
  note: string;
}

/**
 * Every refusal a save can earn, decided rather than performed: outside the workspace, a path a
 * validated writer owns, past the bound, unparseable front-matter, a dropped `type:` tag, and a
 * file that changed underneath. `sceneWriter` names the writer `scenes/` belongs to from the
 * caller's side, so the guard's sentence points at the one that caller should have used.
 *
 * `seenHash` is the hash `readDocFile` returned; the empty string means "I expect no file here",
 * which is how a freshly created document saves before it has ever been read.
 */
export async function checkDocWrite(
  root: string,
  path: string,
  text: string,
  seenHash: string,
  sceneWriter: string,
): Promise<DocResult<DocWritePlan>> {
  const abs = resolveInWorkspace(root, path);
  if (!abs) return refuse(`path "${path}" is outside the workspace`);
  const rel = workspacePath(root, abs);

  if (inSecretsDir(rel)) return refuse(SECRETS_REFUSAL);
  if (guardedDir(rel)) return refuse(`${rel} is written by ${sceneWriter}, not whole`);

  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_DOC_BYTES) return refuse(tooBig(rel, bytes.length));

  let doc: FrontMatterDoc;
  try {
    doc = parseFrontMatter(text);
  } catch (err) {
    // A document's identity lives in its front-matter, so a file whose front-matter will not
    // parse cannot be placed in the model. An unfinished body is left to the author
    return refuse(`${rel}: front-matter will not parse: ${(err as Error).message}`);
  }

  const existing = await readDocFile(root, rel);
  if (!existing.ok && seenHash !== '') {
    return refuse(`${rel} is gone — it was read at ${short(seenHash)} and is not there now`);
  }
  if (existing.ok) {
    if (seenHash === '') return refuse(`${rel} already exists`);
    if (existing.file.hash !== seenHash) {
      return refuse(
        `${rel} changed underneath this edit (read at ${short(seenHash)}, now ` +
          `${short(existing.file.hash)}) — reopen it and reapply`,
      );
    }
    const had = taggedKind(parseFrontMatterOrEmpty(existing.file.text).data);
    if (had && taggedKind(doc.data) !== had) {
      // The tag is what makes the file an entity, so dropping it removes the character from the
      // model and breaks every backlink. That is a deletion rather than an edit
      return refuse(
        `${rel} declares ${ENTITY_TAG_KEY}: ${had}, and this save drops it — that deletes the ` +
          `${had}, which is not an edit`,
      );
    }
  }

  const hash = sha256(bytes);
  const note = !existing.ok
    ? `Creates ${rel}.`
    : existing.file.hash === hash
      ? `${rel} already reads exactly this way.`
      : `Overwrites ${rel} (${bytes.length} bytes).`;
  return { ok: true, file: abs, path: rel, hash, bytes: bytes.length, doc, note };
}

const short = (hash: string): string => hash.slice(0, 12);

/** Front-matter of a file already on disk; unparseable YAML there is not this save's problem. */
function parseFrontMatterOrEmpty(text: string): FrontMatterDoc {
  try {
    return parseFrontMatter(text);
  } catch {
    return { data: {}, body: text };
  }
}

/** `checkDocWrite`, then the atomic write. The only whole-document write path. */
export async function writeDocFile(
  root: string,
  path: string,
  text: string,
  seenHash: string,
  owner: string,
): Promise<DocResult<DocWritePlan>> {
  const plan = await checkDocWrite(root, path, text, seenHash, owner);
  if (!plan.ok) return plan;
  await writeFileAtomic(plan.file, text);
  return plan;
}
