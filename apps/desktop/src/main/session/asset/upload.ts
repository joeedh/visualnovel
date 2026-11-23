import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { sha256 } from '@vn/util';
import { uploadOf, uploadReference } from '@vn/artgen';
import type { RefBinding } from '@vn/types';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject } from '../load/project.js';
import { relPath } from '../load/tree.js';
import { adoptPlan } from './adopt.js';

/**
 * The rule behind both upload halves: read the bytes once, then let `uploadOf` say everything
 * that can be refused. A relative path is resolved against the project, so a command reads the
 * same file the file picker named.
 */
async function uploadPlan(
  session: WorkspaceSession,
  file: string,
  title: string,
  slot: string,
  replace: boolean,
): Promise<
  | { ok: false; reason: string }
  | { ok: true; project: LoadedProject; path: string; note: string; slot?: RefBinding }
> {
  const said = file.trim();
  if (!said) return { ok: false, reason: 'Nothing to upload: no file was named.' };
  const path = isAbsolute(said) ? said : join(session.dir, said);
  const project = await loadProject(session.dir);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    return { ok: false, reason: `Cannot read ${relPath(session.dir, path)}.` };
  }
  const decided = uploadOf(project.store, { file: path, title, bytes });
  if (!decided.ok) return { ok: false, reason: decided.reason };
  if (!slot.trim()) return { ok: true, project, path, note: decided.plan.note };

  // Both refusals before either write: an upload that names a slot is one act, and hearing
  // "that slot is already rendered" after the bytes are copied is hearing it too late.
  const hash = sha256(bytes);
  const adoption = await adoptPlan(session, hash, slot, replace, bytes);
  if (!adoption.ok) return { ok: false, reason: adoption.reason };
  const supersede = adoption.plan.supersedes
    ? ` It supersedes the render ${adoption.plan.supersedes.slice(0, 8)}, whose bytes stay in the store.`
    : ' The next run adopts it instead of rendering one.';
  return {
    ok: true,
    project,
    path,
    slot: adoption.slot,
    note: `Would bring ${basename(path)} in as ${hash.slice(0, 8)} and make it the ${adoption.plan.label}.${supersede}`,
  };
}

/** What `asset.upload` would bring in, without writing anything. */
export async function previewUpload(
  session: WorkspaceSession,
  file: string,
  title: string,
  slot = '',
  replace = false,
): Promise<{ ok: boolean; message: string }> {
  const decided = await uploadPlan(session, file, title, slot, replace);
  return decided.ok ? { ok: true, message: decided.note } : { ok: false, message: decided.reason };
}

/**
 * Bring an outside image into the base asset store. With no slot it is a `reference`: nothing
 * generated it, so it is never accepted and never planned — it exists only to be pointed at by a
 * prompt chunk. With a slot it is filed the same way and then adopted as that slot's output.
 */
export async function uploadAsset(
  session: WorkspaceSession,
  file: string,
  title: string,
  slot = '',
  replace = false,
): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
  const decided = await uploadPlan(session, file, title, slot, replace);
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const { project, path } = decided;
  const result = await uploadReference({ store: project.store }, { file: path, title });
  const already = result.known ? ' It was already in the store; nothing new was written.' : '';
  const uploaded = `Uploaded "${result.title}" as ${result.ref.hash.slice(0, 8)}.${already}`;
  const written = [
    relPath(session.dir, result.stored),
    relPath(session.dir, project.paths.baseManifest),
  ];
  if (!decided.slot) return { ok: true, message: uploaded, hash: result.ref.hash, written };

  // The bytes are in by now, so a refusal here is recoverable rather than lost — which is what
  // the message has to say, because the author's file did land somewhere.
  const adopted = await session.adoptAsset(result.ref.hash, slot, replace, 'upload');
  if (!adopted.ok) {
    return {
      ok     : false,
      message: `${uploaded} It could not be adopted, and stays a reference: ${adopted.message} Finish with asset.adopt(hash='${result.ref.hash}' slot='${slot}').`,
      hash   : result.ref.hash,
      written,
    };
  }
  return {
    ok     : true,
    message: `${uploaded} ${adopted.message}`,
    hash   : result.ref.hash,
    written: [...written, ...adopted.written],
  };
}

/**
 * Copy one asset's bytes to a path the author chose. Nothing about the project changes — this is
 * the picture leaving, not the project being edited — so no manifest is touched and no
 * provenance is written, and the path is deliberately not narrowed to the workspace.
 */
export async function exportAsset(
  session: WorkspaceSession,
  hash: string,
  file: string,
): Promise<{ ok: boolean; message: string; file?: string }> {
  const project = await loadProject(session.dir);
  const asset = project.store.manifest().find((a) => a.hash === hash);
  if (!asset) return { ok: false, message: `No asset "${hash}" in the manifest.` };
  const bytes = await project.store.read({ hash: asset.hash, ext: asset.ext });
  await writeFile(file, bytes);
  return { ok: true, message: `Saved ${basename(file)}.`, file };
}
