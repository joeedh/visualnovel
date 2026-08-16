/**
 * The hash of what a shot's covered lines say — the value drift is measured against.
 *
 * It lives here rather than beside `driftOf` in `@vn/pipeline` because adoption stamps it: a frame
 * an artist handed in is answerable for the lines it was drawn from, exactly as a rendered one is,
 * and a second spelling of "what the prose was" would make every drift report a coin toss.
 */
import type { Scene } from '@vn/types';
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
