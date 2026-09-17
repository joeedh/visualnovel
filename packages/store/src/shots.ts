/**
 * Persisted shot decompositions — `work/shots/<sceneId>.json`, one file per scene.
 *
 * This module is the only place the on-disk shape and the in-memory `Shot` are mapped to each
 * other. On disk the authored fields sit at the top level and everything a run produced is nested
 * under `shotData`, which shows the reader which half a human owns. In memory `Shot` stays flat,
 * because the planner and the runners work with it that way. Keeping the mapping here also forces
 * `shotData` to be constructed at write time from the run's results rather than carried around
 * and trusted.
 */
import fs from 'node:fs/promises';
import type { PagePanel, SheetGroup, Shot, ShotsFile } from '@vn/types';
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
  /**
   * Lines a page shot covers but letters in no panel, per shot. The page still renders and
   * playback shows the whole page for such a line; a caller reports it as `line_in_no_panel`.
   */
  unpanelled: { shotId: string; lineIds: string[] }[];
  /**
   * High-water mark for hand-allocated `__shot<n>` ids; see `shotsFileSchema`. Absent on
   * decomposed and pre-mark files — `derivedNextShot` in `@vn/scriptedit` covers those.
   */
  nextShot?: number;
  /** The scene's staging-sheet groups, when the file declares any. */
  sheets?: Record<string, SheetGroup>;
}

/**
 * The file's panels as the flat shot carries them, each panel's lines cut down to the lines the
 * shot still covers. The shot's own `coversLines` is the authority on coverage, so a panel line
 * the shot lost (to a screenplay edit, or a hand edit of the file) follows it out silently, and
 * its bubble with it.
 */
function panelsOf(raw: ShotsFile['shots'][number], kept: readonly string[]): PagePanel[] {
  const covered = new Set(kept);
  return raw.panels!.map((p) => {
    const lines = p.coversLines.filter((id) => covered.has(id));
    const panel: PagePanel = {
      shape      : p.shape,
      framing    : p.framing,
      subjects   : p.subjects,
      coversLines: lines,
    };
    if (p.camera !== undefined) panel.camera = p.camera;
    if (p.artNotes !== undefined) panel.artNotes = p.artNotes;
    const bubbles = (p.bubbles ?? []).filter((b) => lines.includes(b.lineId));
    if (bubbles.length) panel.bubbles = bubbles;
    return panel;
  });
}

/**
 * A panel may cast only the parent shot's subjects: the cast list is what decides outfits and
 * references, so a name found only in a panel would reach the prompt with no sheet behind it.
 * Reported rather than repaired, since either the cast or the panel could be the mistake.
 */
function castErrors(raw: ShotsFile['shots'][number], file: string): ValidationError | undefined {
  const cast = new Set(raw.subjects.map((s) => s.characterId));
  const issues = (raw.panels ?? []).flatMap((p, i) =>
    p.subjects
      .filter((s) => !cast.has(s.characterId))
      .map((s) => ({
        code   : 'panel_subject_not_in_cast',
        message: `panel ${i + 1} of ${raw.id} casts "${s.characterId}", who is not in the shot's cast`,
        where  : `${file}:shots.${raw.id}.panels.${i}`,
      })),
  );
  return issues.length ? new ValidationError(`malformed shots file: ${file}`, issues) : undefined;
}

/**
 * Read one scene's persisted shots, or `null` when the file does not exist, which is the only
 * signal a caller may use to decide "decompose this scene". The file may be written by a
 * decomposer or created around the first hand-made shot; either way it is never regenerated
 * afterwards. A malformed file throws rather than being ignored, so a silent re-decomposition
 * never overwrites a hand edit.
 *
 * `knownLineIds`, when given, drops `coversLines` entries the scene no longer has (the
 * screenplay was edited under the shots). The shot itself is kept, and each drop is returned
 * so the caller can report it.
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
        code   : 'shots_file',
        message: i.message,
        where  : `${file}:${i.path.join('.')}`,
      })),
    );
  }

  const dropped: LoadedShots['dropped'] = [];
  const unpanelled: LoadedShots['unpanelled'] = [];
  const shots = parsed.data.shots.map((s) => {
    const cast = castErrors(s, file);
    if (cast) throw cast;
    const kept = knownLineIds ? s.coversLines.filter((id) => knownLineIds.has(id)) : s.coversLines;
    if (kept.length !== s.coversLines.length) {
      dropped.push({
        shotId : s.id,
        lineIds: s.coversLines.filter((id) => !kept.includes(id)),
      });
    }
    const shot: Shot = {
      id         : s.id,
      sceneId    : s.sceneId,
      framing    : s.framing,
      location   : s.location,
      subjects   : s.subjects,
      coversLines: kept,
      status     : s.shotData?.status ?? 'pending',
    };
    if (s.castOptional !== undefined) shot.castOptional = s.castOptional;
    if (s.camera !== undefined) shot.camera = s.camera;
    if (s.artNotes !== undefined) shot.artNotes = s.artNotes;
    if (s.seed !== undefined) shot.seed = s.seed;
    if (s.aspect !== undefined) shot.aspect = s.aspect;
    if (s.imageModel !== undefined) shot.imageModel = s.imageModel;
    if (s.panels) {
      shot.panels = panelsOf(s, kept);
      const lettered = new Set(shot.panels.flatMap((p) => p.coversLines));
      const orphaned = kept.filter((id) => !lettered.has(id));
      if (orphaned.length) unpanelled.push({ shotId: s.id, lineIds: orphaned });
    }
    if (s.sheet !== undefined) shot.sheet = s.sheet;
    if (s.promptOverride) shot.promptOverride = promptOverrideFrom(s.promptOverride);
    if (s.shotData?.prompt !== undefined) shot.prompt = s.shotData.prompt;
    if (s.shotData?.image !== undefined) shot.image = s.shotData.image;
    if (s.shotData?.proseHash !== undefined) shot.proseHash = s.shotData.proseHash;
    if (s.shotData?.panelBoxes !== undefined) shot.panelBoxes = s.shotData.panelBoxes;
    return shot;
  });

  const loaded: LoadedShots = { shots, dropped, unpanelled };
  if (parsed.data.nextShot !== undefined) loaded.nextShot = parsed.data.nextShot;
  if (parsed.data.sheets !== undefined) loaded.sheets = parsed.data.sheets;
  return loaded;
}

/** The file-level fields a writer carries through unchanged unless it says otherwise. */
interface FileMarks {
  nextShot?: number;
  sheets?: Record<string, SheetGroup>;
}

/** A panel as written: the authored keys in a fixed order, each optional one only when set. */
function panelDoc(p: PagePanel): Record<string, unknown> {
  return {
    shape  : p.shape,
    framing: p.framing,
    ...(p.camera !== undefined ? { camera: p.camera } : {}),
    subjects   : p.subjects,
    coversLines: p.coversLines,
    ...(p.artNotes !== undefined ? { artNotes: p.artNotes } : {}),
    // Only once one is placed, so a page written before bubbles existed stays byte-stable
    ...(p.bubbles?.length ? { bubbles: p.bubbles } : {}),
  };
}

/** The file text for a set of shots — flat `Shot`s projected into the nested on-disk shape. */
function serialize(sceneId: string, shots: readonly Shot[], marks: FileMarks): string {
  const file = {
    version: 1,
    scene  : sceneId,
    // Only present once a hand-made shot has spent an id, so decomposed files stay byte-stable.
    ...(marks.nextShot !== undefined ? { nextShot: marks.nextShot } : {}),
    // Likewise only once a scene has a staging group.
    ...(marks.sheets !== undefined ? { sheets: marks.sheets } : {}),
    shots: shots.map((s) => ({
      id      : s.id,
      sceneId : s.sceneId,
      framing : s.framing,
      location: s.location,
      subjects: s.subjects,
      // Only when set, so a file that never turned enforcement off stays byte-stable.
      ...(s.castOptional ? { castOptional: true } : {}),
      ...(s.camera !== undefined ? { camera: s.camera } : {}),
      ...(s.artNotes !== undefined ? { artNotes: s.artNotes } : {}),
      ...(s.seed !== undefined ? { seed: s.seed } : {}),
      ...(s.aspect !== undefined ? { aspect: s.aspect } : {}),
      ...(s.imageModel !== undefined ? { imageModel: s.imageModel } : {}),
      ...(s.panels !== undefined ? { panels: s.panels.map(panelDoc) } : {}),
      ...(s.sheet !== undefined ? { sheet: s.sheet } : {}),
      // An override that says nothing is not written: it would change nothing about the prompt,
      // and a shots file that grows an inert key stops rewriting byte-identically.
      ...(promptOverrideIsEmpty(s.promptOverride)
        ? {}
        : { promptOverride: promptOverrideToDoc(s.promptOverride!) }),
      coversLines: s.coversLines,
      // Omitted until a run has produced something, so a freshly decomposed file holds only
      // authored material.
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
              // Beside the image for the same reason: the boxes were seen in these bytes.
              ...(s.image !== undefined && s.panelBoxes !== undefined
                ? { panelBoxes: s.panelBoxes }
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
 *
 * A caller that says nothing about `nextShot` preserves the file's existing mark. Most
 * writers here — the planner, shot fallout, the outfit editors — are rewriting shots they
 * loaded, and dropping the mark on their way through would quietly resurrect id reuse.
 * Only the two acts that move the mark (`story.newShot` spends an id, `story.deleteShot`
 * carries it into the rewritten file) pass one. The scene's `sheets` are carried the same way.
 */
export async function writeShots(
  paths: ProjectPaths,
  sceneId: string,
  shots: readonly Shot[],
  opts?: FileMarks,
): Promise<boolean> {
  const file = paths.shotsFile(sceneId);
  const had = await exists(file);
  const before = had ? await readText(file) : undefined;
  const marks: FileMarks = {};
  if (opts?.nextShot !== undefined) marks.nextShot = opts.nextShot;
  if (opts?.sheets !== undefined) marks.sheets = opts.sheets;
  if (before !== undefined) {
    try {
      const raw = JSON.parse(before) as { nextShot?: unknown; sheets?: unknown };
      if (marks.nextShot === undefined && typeof raw.nextShot === 'number') {
        marks.nextShot = raw.nextShot;
      }
      if (marks.sheets === undefined && raw.sheets && typeof raw.sheets === 'object') {
        marks.sheets = raw.sheets as FileMarks['sheets'];
      }
    } catch {
      // Unparseable is readShots's problem to report; an overwrite here keeps the caller's shots.
    }
  }
  const next = serialize(sceneId, shots, marks);
  if (before === next) return false;
  await writeFileAtomic(file, next);
  return true;
}

/**
 * Remove one scene's shots file. Deliberately not "write an empty list": an absent file is the
 * only signal that means "decompose this scene", so a scene that lost its last shot must lose the
 * file to be storyboarded again. Returns whether there was a file to remove; an absent file is not
 * an error, since the caller decided against an older load.
 */
export async function deleteShots(paths: ProjectPaths, sceneId: string): Promise<boolean> {
  const file = paths.shotsFile(sceneId);
  if (!(await exists(file))) return false;
  await fs.rm(file);
  return true;
}
