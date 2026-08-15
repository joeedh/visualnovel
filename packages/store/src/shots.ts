/**
 * Persisted shot decompositions — `work/shots/<sceneId>.json`, one file per scene.
 *
 * This module is the **only** place the on-disk shape and the in-memory `Shot` are mapped to
 * each other. On disk the authored fields sit at the top level and everything a run produced
 * is nested under `shotData`, so the file says which half a human owns; in memory `Shot` stays
 * flat, because the planner and the runners work with it that way. Keeping the mapping here is
 * also what forces `shotData` to be *constructed* at write time from the run's results rather
 * than carried around and quietly trusted.
 */
import fs from 'node:fs/promises';
import type { Shot } from '@vn/types';
import {
  promptOverrideFrom,
  promptOverrideIsEmpty,
  promptOverrideToDoc,
  shotsFileSchema,
} from '@vn/types';
import { exists, readText, ValidationError, writeFileAtomic } from '@vn/util';
import type { ProjectPaths } from './paths.js';

/** A scene's persisted shots, plus whatever the screenplay no longer supports. */
export interface LoadedShots {
  shots: Shot[];
  /** Line ids dropped because the scene no longer has them, per shot. */
  dropped: { shotId: string; lineIds: string[] }[];
}

/**
 * Read one scene's persisted shots, or `null` when the file does not exist — which is the
 * only signal a caller may use to decide "decompose this scene". A malformed file throws
 * rather than being ignored: silently re-decomposing over a hand-edit is the one behaviour
 * that would make the file untrustworthy to edit.
 *
 * `knownLineIds`, when given, drops `coversLines` entries the scene no longer has (the
 * screenplay was edited under the shots). The shot itself is kept, and the drop is reported
 * so the caller can say so.
 */
export async function readShots(
  paths: ProjectPaths,
  sceneId: string,
  knownLineIds?: ReadonlySet<string>,
): Promise<LoadedShots | null> {
  const file = paths.shotsFile(sceneId);
  if (!(await exists(file))) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(await readText(file));
  } catch (err) {
    throw new ValidationError(`unparseable shots file for scene "${sceneId}"`, [
      { code: 'shots_file', message: (err as Error).message, where: file },
    ]);
  }

  const parsed = shotsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `malformed shots file for scene "${sceneId}"`,
      parsed.error.issues.map((i) => ({
        code: 'shots_file',
        message: i.message,
        where: `${file}:${i.path.join('.')}`,
      })),
    );
  }

  const dropped: LoadedShots['dropped'] = [];
  const shots = parsed.data.shots.map((s) => {
    const kept = knownLineIds ? s.coversLines.filter((id) => knownLineIds.has(id)) : s.coversLines;
    if (kept.length !== s.coversLines.length) {
      dropped.push({
        shotId: s.id,
        lineIds: s.coversLines.filter((id) => !kept.includes(id)),
      });
    }
    const shot: Shot = {
      id: s.id,
      sceneId: s.sceneId,
      framing: s.framing,
      location: s.location,
      subjects: s.subjects,
      coversLines: kept,
      status: s.shotData?.status ?? 'pending',
    };
    if (s.camera !== undefined) shot.camera = s.camera;
    if (s.artNotes !== undefined) shot.artNotes = s.artNotes;
    if (s.promptOverride) shot.promptOverride = promptOverrideFrom(s.promptOverride);
    if (s.shotData?.prompt !== undefined) shot.prompt = s.shotData.prompt;
    if (s.shotData?.image !== undefined) shot.image = s.shotData.image;
    if (s.shotData?.proseHash !== undefined) shot.proseHash = s.shotData.proseHash;
    return shot;
  });

  return { shots, dropped };
}

/** The file text for a set of shots — flat `Shot`s projected into the nested on-disk shape. */
function serialize(sceneId: string, shots: readonly Shot[]): string {
  const file = {
    version: 1,
    scene: sceneId,
    shots: shots.map((s) => ({
      id: s.id,
      sceneId: s.sceneId,
      framing: s.framing,
      location: s.location,
      subjects: s.subjects,
      ...(s.camera !== undefined ? { camera: s.camera } : {}),
      ...(s.artNotes !== undefined ? { artNotes: s.artNotes } : {}),
      // An override that says nothing is not written: it would change nothing about the prompt,
      // and a shots file that grows an inert key stops rewriting byte-identically.
      ...(promptOverrideIsEmpty(s.promptOverride)
        ? {}
        : { promptOverride: promptOverrideToDoc(s.promptOverride!) }),
      coversLines: s.coversLines,
      // Omitted entirely until a run has produced something, so a freshly decomposed file is
      // purely authored material and reads as one.
      ...(s.prompt !== undefined || s.image !== undefined || s.status !== 'pending'
        ? {
            shotData: {
              ...(s.prompt !== undefined ? { prompt: s.prompt } : {}),
              ...(s.image !== undefined ? { image: s.image } : {}),
              // Only ever written beside an image: on its own it would claim a frame was made
              // from these words when no frame exists.
              ...(s.image !== undefined && s.proseHash !== undefined
                ? { proseHash: s.proseHash }
                : {}),
              status: s.status,
            },
          }
        : {}),
    })),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/**
 * Write one scene's shots, skipping a byte-identical rewrite. The planner calls this once per
 * scheduler wave and `work/` is committed, so an unchanged rerun must leave the tree clean.
 * Returns whether anything was written.
 */
export async function writeShots(
  paths: ProjectPaths,
  sceneId: string,
  shots: readonly Shot[],
): Promise<boolean> {
  const file = paths.shotsFile(sceneId);
  const next = serialize(sceneId, shots);
  if ((await exists(file)) && (await readText(file)) === next) return false;
  await writeFileAtomic(file, next);
  return true;
}

/**
 * Remove one scene's shots file. Deliberately not "write an empty list": an absent file is the
 * only signal that means "decompose this scene", so a scene whose last shot went away has to lose
 * the file to get a fresh storyboard instead of staying blank forever. Returns whether there was
 * one to remove — an absent file is not an error, since the caller decided against an older load.
 */
export async function deleteShots(paths: ProjectPaths, sceneId: string): Promise<boolean> {
  const file = paths.shotsFile(sceneId);
  if (!(await exists(file))) return false;
  await fs.rm(file);
  return true;
}
