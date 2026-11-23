import {
  artNotesOf,
  artModelOf,
  artSeedOf,
  setArtNotes as writeArtNotes,
  setArtModel as writeArtModel,
  setArtSeed as writeArtSeed,
} from '@vn/artgen';
import type { WorkspaceSession } from '../core.js';
import { loadProject } from '../load/project.js';
import { relPath } from '../load/tree.js';

/** What `art.setNotes` would do, without writing it. */
export async function previewArtNotes(
  session: WorkspaceSession,
  target: string,
  notes: string,
): Promise<{ ok: boolean; message: string }> {
  const { config, paths } = await loadProject(session.dir);
  const decided = await artNotesOf({ config, paths }, { target, notes });
  return decided.ok
    ? { ok: true, message: decided.plan.note }
    : { ok: false, message: decided.reason };
}

/**
 * Write one art-notes rung, through the rule `vnauthor`'s `set_art_notes` runs — an entity rung
 * into the sheet the model was built from, a shot rung into `work/shots/<sceneId>.json`.
 */
export async function setArtNotes(
  session: WorkspaceSession,
  target: string,
  notes: string,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const { config, paths } = await loadProject(session.dir);
  const deps = { config, paths };
  const decided = await artNotesOf(deps, { target, notes });
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const plan = await writeArtNotes(deps, { target, notes });
  return { ok: true, message: plan.note, written: [relPath(session.dir, plan.file)] };
}

/** What `art.setSeed` would do, without writing it. */
export async function previewArtSeed(
  session: WorkspaceSession,
  target: string,
  seed: number | null,
): Promise<{ ok: boolean; message: string }> {
  const { config, paths } = await loadProject(session.dir);
  const decided = await artSeedOf({ config, paths }, { target, seed });
  return decided.ok
    ? { ok: true, message: decided.plan.note }
    : { ok: false, message: decided.reason };
}

/** Write one rung's image seed, into the same two files `setArtNotes` writes. */
export async function setArtSeed(
  session: WorkspaceSession,
  target: string,
  seed: number | null,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const { config, paths } = await loadProject(session.dir);
  const deps = { config, paths };
  const decided = await artSeedOf(deps, { target, seed });
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const plan = await writeArtSeed(deps, { target, seed });
  return { ok: true, message: plan.note, written: [relPath(session.dir, plan.file)] };
}

/** What `art.setModel` would do, without writing it. */
export async function previewArtModel(
  session: WorkspaceSession,
  target: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  const { config, paths } = await loadProject(session.dir);
  const decided = await artModelOf({ config, paths }, { target, model });
  return decided.ok
    ? { ok: true, message: decided.plan.note }
    : { ok: false, message: decided.reason };
}

/** Write one rung's image model, into the same two files `setArtNotes` writes. */
export async function setArtModel(
  session: WorkspaceSession,
  target: string,
  model: string,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const { config, paths } = await loadProject(session.dir);
  const deps = { config, paths };
  const decided = await artModelOf(deps, { target, model });
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const plan = await writeArtModel(deps, { target, model });
  return { ok: true, message: plan.note, written: [relPath(session.dir, plan.file)] };
}
