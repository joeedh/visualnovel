/**
 * Whether a shot's art still illustrates the words it sits against.
 *
 * It has to be asked, because nothing else notices. `buildShotPrompt` reads no line text — prose
 * reaches only the P7 reviewer's spec, which never enters a task's `inputs` — so retyping a covered
 * line changes no task hash, re-renders nothing, and leaves the frame depicting words the scene no
 * longer contains. That is what makes prose editing affordable, and it is why the cost has to be
 * *reported* instead of charged.
 *
 * The comparison is over the prose and only the prose. Not the task hash: that is precisely the
 * hash line text cannot move, so comparing task hashes compares a value to itself. And not a
 * `drifted: true` flag either — `shotData` is rewritten wholesale each pass, so a flag can be
 * stale, restored from an old commit, or missed by an edit that took another path. A hash recorded
 * with the bytes and re-derived on every load is self-healing, and correct for edits made through
 * the CLI, the agent, or by hand in the chunk file.
 */
import type { Drift, Scene, Shot } from '@vn/types';
import { hashParts } from '@vn/util';

/**
 * Hash of what a shot's covered lines say, taken in **scene order** rather than `coversLines`
 * order — coverage is a set, and reordering the array is not a change to the prose.
 *
 * A coverage edit does move this hash, because it changes which words the frame is answerable for.
 * That is one question, not two: extending a bracket over another line makes the frame no longer
 * illustrate what it covers, in exactly the sense a retype does.
 */
export function proseHash(scene: Scene, coversLines: readonly string[]): string {
  const covered = new Set(coversLines);
  return hashParts(scene.lines.filter((l) => covered.has(l.id)).map((l) => l.text));
}

/** Where a shot stands against its scene as loaded. Pure, and cheap enough to run on every read. */
export function driftOf(scene: Scene, shot: Shot): Drift {
  if (shot.image === undefined) return 'unrendered';
  if (shot.proseHash === undefined) return 'unknown';
  return shot.proseHash === proseHash(scene, shot.coversLines) ? 'current' : 'drifted';
}
