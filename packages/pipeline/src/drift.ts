/**
 * Whether a shot's art still illustrates the words it sits against.
 *
 * Nothing else in the pipeline detects this. `buildShotPrompt` reads no line text (prose reaches
 * only the P7 reviewer's spec, which never enters a task's `inputs`), so retyping a covered line
 * changes no task hash, re-renders nothing, and leaves the frame depicting words the scene no
 * longer contains. Prose editing is therefore cheap, and the cost is reported rather than charged.
 *
 * The comparison is over the prose and only the prose. It is not over the task hash, which is
 * exactly the hash line text cannot move, so comparing task hashes would compare a value to
 * itself. It is also not a `drifted: true` flag: `shotData` is rewritten wholesale each pass, so
 * a flag can go stale, be restored from an old commit, or be missed by an edit that took another
 * path. A hash recorded with the bytes and re-derived on every load stays correct for edits made
 * through the CLI, the agent, or by hand in the chunk file.
 */
import type { Drift, Scene, Shot } from '@vn/types';
import { proseHash } from '@vn/artgen';

// Defined in `@vn/artgen` because adoption stamps the same hash; re-exported by name so callers
// asking whether a frame is stale still find it here
export { proseHash };

/** Where a shot stands against its scene as loaded. Pure, and cheap enough to run on every read. */
export function driftOf(scene: Scene, shot: Shot): Drift {
  if (shot.image === undefined) return 'unrendered';
  if (shot.proseHash === undefined) return 'unknown';
  return shot.proseHash === proseHash(scene, shot.coversLines) ? 'current' : 'drifted';
}
