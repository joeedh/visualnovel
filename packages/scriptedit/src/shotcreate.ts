/**
 * Making and unmaking shots by hand: the pure halves of `story.newShot` and `story.deleteShot`.
 *
 * Decomposition is one way a storyboard comes into being; these functions are the other. Both
 * hosts — the desktop's timeline and the authoring agent's tools — run these same rules, so a shot
 * made by drag and a shot made by an agent's `edit_scene` op are refused and priced by the same
 * sentences.
 *
 * Two postures carried over from elsewhere in the repo:
 *
 * - A retired shot id is never reused. A shot's task identity is `sha256(kind, inputs)` and
 *   the id is in the inputs, so recreating `scene__shot1` after deleting it would hash to an
 *   already-`done` task and silently inherit the deleted shot's frame. Ids come from a `nextShot`
 *   high-water mark persisted in the shots file (the `Scene.nextLineId` posture) which only
 *   ever rises. Older files (and every decomposed one) carry no mark, so it is derived by
 *   scanning existing ids; the scan covers model-minted `shot<n>` ids too, not just ours.
 * - A new shot must claim at least one line. A shot covering nothing is a state the timeline
 *   reveals, never one a creation produces.
 */

import type { SceneLine, Shot, ShotSubject } from '@vn/types';
import { setCoverage, type CoverShot } from './coverage.js';

/** What `newShot` reads off a scene: identity, the lines (for order and speakers), the heading's variant. */
export interface ShotScene {
  id: string;
  lines: readonly Pick<SceneLine, 'id' | 'speaker'>[];
  locationVariant?: string | undefined;
}

/**
 * A storyboard as loaded from disk — or `null`, meaning the scene is undecomposed. Generic so a
 * host can judge the rule against its own projection of a shot (the timeline's `CoverageShot`):
 * the decision reads only `id` and `coversLines`, and only a writer needs the full `Shot`s back.
 */
export interface ShotBoard<S extends CoverShot = Shot> {
  shots: readonly S[];
  /** The persisted high-water mark; absent on decomposed and pre-mark files. */
  nextShot?: number | undefined;
}

export type NewShotOp<S extends CoverShot = Shot> =
  | {
      ok: true;
      /** The shot that was made. */
      shot: Shot;
      /** The whole storyboard after the edit, coverage takes applied. */
      shots: (S | Shot)[];
      /** The mark to persist: one past the id just spent. */
      nextShot: number;
      /** True when the scene had no storyboard — this act created it, ending decomposition. */
      created: boolean;
      /** Line ids no shot covers after the edit. */
      uncovered: string[];
      message: string;
    }
  | { ok: false; error: string };

export type DeleteShotOp =
  | {
      ok: true;
      /** The storyboard after removal. Empty means the file itself goes (see `deleteFile`). */
      shots: Shot[];
      /**
       * True when the last shot was removed. The caller deletes the file rather than writing an
       * empty list — an absent file is what "decompose this scene" looks like, and an empty list
       * is never written.
       */
      deleteFile: boolean;
      /** Line ids the deleted shot covered, now gaps. Never handed to a neighbour. */
      released: string[];
      /** The mark to carry into the rewritten file, so the deleted id stays retired. */
      nextShot: number;
      message: string;
    }
  | { ok: false; error: string };

const SHOT_ID = /__shot(\d+)$/;

/**
 * The high-water mark for a file that never recorded one: one past the highest `__shot<n>`
 * suffix in use. The scan matters because the model-driven decomposer may itself mint a raw
 * `shot<n>` id (namespaced to `scene__shot<n>`), so "no mark" does not mean "no such ids".
 */
export function derivedNextShot(shots: readonly Pick<Shot, 'id'>[]): number {
  let high = 0;
  for (const shot of shots) {
    const m = SHOT_ID.exec(shot.id);
    if (m) high = Math.max(high, Number(m[1]));
  }
  return high + 1;
}

const nextShotOf = (board: ShotBoard<CoverShot> | null): number =>
  board === null ? 1 : (board.nextShot ?? derivedNextShot(board.shots));

/**
 * Create a shot covering `args.lines`, allocating its id from the high-water mark.
 *
 * On an undecomposed scene (`board === null`) this creates the storyboard — which is a bigger
 * act than adding one shot, because a shots file, once written, is never regenerated: the scene
 * will never be decomposed, and every line the new shot did not claim stays uncovered until the
 * author covers it. The message says so; the command's `check` must too. `withCoverage`'s
 * first-line repair is a decomposer's backstop and deliberately does not run here.
 *
 * Initial coverage goes through `setCoverage`, so a birth that would empty a neighbour is
 * refused by the same sentence a drag gets. Defaults: framing `medium`, the heading's location
 * variant (validated against `args.variants` the way the model decomposer's answer is), subjects
 * are the speakers of the claimed lines, and no outfit — absent means inherit.
 *
 * `args.subjects` names the cast instead, for the shots the speakers do not describe: a reaction
 * on a listener, an establishing frame over narration, a character present but silent. Nothing
 * else can set a shot's subjects afterwards, so an unnamed character is refused here rather than
 * reaching the prompt as an id no sheet answers.
 */
export function newShot<S extends CoverShot>(
  scene: ShotScene,
  board: ShotBoard<S> | null,
  args: {
    lines: readonly string[];
    framing?: Shot['framing'] | undefined;
    /**
     * Character ids in frame, in the order they matter. An empty list and an omitted list both
     * default to the speakers of the claimed lines, since a shot framing nobody is what narration
     * already produces and does not need a second way of saying it.
     */
    subjects?: readonly string[] | undefined;
    /** The scene's location variant ids, for validating the default. */
    variants?: readonly string[] | undefined;
    /** The project's character ids, for refusing a subject nothing describes. */
    cast?: readonly string[] | undefined;
  },
): NewShotOp<S> {
  if (args.lines.length === 0) {
    return { ok: false, error: 'A new shot must cover at least one line.' };
  }

  const named = [...new Set(args.subjects ?? [])];
  const cast = args.cast ?? [];
  if (cast.length > 0) {
    const unknown = named.filter((id) => !cast.includes(id));
    if (unknown.length > 0) {
      return { ok: false, error: `No character "${unknown[0]}" in this project.` };
    }
  }

  const n = nextShotOf(board);
  const id = `${scene.id}__shot${n}`;
  const existing = board?.shots ?? [];

  const covers: CoverShot[] = [
    ...existing.map((s) => ({ id: s.id, coversLines: [...s.coversLines] })),
    { id, coversLines: [] },
  ];
  const op = setCoverage(covers, {
    shot: id,
    lines: args.lines,
    lineOrder: scene.lines.map((l) => l.id),
  });
  if (!op.ok) return { ok: false, error: op.error };

  const taken = new Map(op.changed.map((s) => [s.id, s.coversLines]));
  const coversLines = taken.get(id)!;

  const variants = args.variants ?? [];
  const location =
    scene.locationVariant && (variants.length === 0 || variants.includes(scene.locationVariant))
      ? scene.locationVariant
      : (variants[0] ?? 'day');

  const claimed = new Set(coversLines);
  const speakers = scene.lines.filter((l) => claimed.has(l.id) && l.speaker).map((l) => l.speaker!);
  const inFrame = named.length > 0 ? named : [...new Set(speakers)];
  const subjects: ShotSubject[] = inFrame.map((characterId) => ({ characterId }));

  const shot: Shot = {
    id,
    sceneId: scene.id,
    framing: args.framing ?? 'medium',
    location,
    subjects,
    coversLines,
    status: 'pending',
  };
  const shots = [
    ...existing.map((s) => ({ ...s, coversLines: taken.get(s.id) ?? s.coversLines })),
    shot,
  ];

  const created = board === null;
  const parts = [`${id} covers ${coversLines.length} line(s) — a new frame to render.`];
  // Only when named. The derived answer is already visible in the lines the shot claimed, and
  // repeating it would bury the two sentences below that cost something.
  if (named.length > 0) parts.push(`It frames ${named.join(', ')}.`);
  if (created) {
    parts.push(
      `This creates the storyboard for ${scene.id} and ends decomposition for this scene: ` +
        `every uncovered line stays uncovered until you cover it.`,
    );
  } else if (op.uncovered.length) {
    parts.push(`${op.uncovered.length} line(s) remain uncovered.`);
  }
  return {
    ok: true,
    shot,
    shots,
    nextShot: n + 1,
    created,
    uncovered: op.uncovered,
    message: parts.join(' '),
  };
}

/**
 * Remove a shot. Its lines become gaps — releasing never hands coverage to a neighbour the
 * author did not name. Removing the last shot means the file itself is deleted (`deleteFile`),
 * restoring the one signal that means "decompose this scene"; an empty list is never written.
 *
 * The returned `nextShot` keeps the deleted id retired: it is the persisted mark, or the
 * derivation over the board as it stood before removal, so the id just freed cannot be re-minted
 * and inherit the dead shot's frame.
 */
export function deleteShot(board: ShotBoard, args: { shot: string }): DeleteShotOp {
  const target = board.shots.find((s) => s.id === args.shot);
  if (!target) return { ok: false, error: `No shot "${args.shot}" in this scene.` };

  const shots = board.shots.filter((s) => s.id !== args.shot).map((s) => ({ ...s }));
  const deleteFile = shots.length === 0;
  const released = [...target.coversLines];

  const parts = [`Deletes ${target.id}; ${released.length} line(s) it covered become uncovered.`];
  if (target.image) {
    parts.push(
      'Its rendered frame is orphaned — art that was paid for and will no longer be shown.',
    );
  }
  if (deleteFile) {
    parts.push(
      `It is the last shot, so the storyboard file is deleted: the scene has no shots left ` +
        `and will be decomposed again.`,
    );
  }
  return {
    ok: true,
    shots,
    deleteFile,
    released,
    nextShot: board.nextShot ?? derivedNextShot(board.shots),
    message: parts.join(' '),
  };
}
