/**
 * Prose drift: whether a shot's art still illustrates the words it covers. The stills family
 * reports it on a shot slot's `SlotState.drift` through the shot kind's `drift`, and adoption
 * stamps the same hash, so a frame an artist handed in is answerable for its lines exactly as a
 * rendered one is.
 */
import type { Drift, Scene, Shot } from '@vn/types';
import { contract } from '@vn/contracts';
import { hashParts } from '@vn/util';

export const scriptProseDriftReported = contract({
  id      : 'script.proseDriftReported',
  rule: "Editing a scene's prose never invalidates a frame's art, so drift is reported: `driftOf` compares the hash of a frame's covered lines, stamped with its image, against the same hash now, and a drifted frame's shot slot says so on `SlotState.drift`.",
  prevents:
    'A frame silently illustrating words the scene no longer contains, or a stored flag that goes stale, comes back from an old commit, or misses an edit that took another path.',
  subjects: [
    'function:packages/stills/src/drift.ts#driftOf',
    'function:packages/stills/src/drift.ts#proseHash',
    'function:packages/stills/src/family.ts#shotKind',
    'function:packages/stills/src/prompts.ts#buildShotPrompt',
    'module:apps/desktop/src/main/session/story.ts',
    'command:story.setLineText',
  ],
  see: [
    'docs/plans/archive/INDEX.md#line-editing-in-floor',
    'docs/reference/desktop-app-editors-story.md#shot-coverage',
  ],
  detail:
    '`buildShotPrompt` reads neither `coversLines` nor line text on a frame, because prose ' +
    "reaches only the P7 reviewer spec, which never enters a task's `inputs`. Retyping a covered " +
    'line therefore rehashes nothing and re-renders nothing, and the frame still illustrates ' +
    'words the scene no longer contains, so it is checked against the words it covers. A page ' +
    'under `lettering: model` is the one exception: its lettered lines are in its prompt, so ' +
    'retyping one, or moving one between panels, re-keys the page. Drift on a page therefore ' +
    'only ever means a line that changed without changing the prompt, which under ' +
    "`lettering: runner` is every line. `Shot.proseHash` records a hash of the covered lines' " +
    'text at the moment the image was produced. It is persisted under `shotData`, is written ' +
    'only beside an image, and is stamped only when the bytes are new, so a rerun that reports ' +
    'the same image cannot re-baseline the prose beneath it or clear a drift nobody acted on. ' +
    '`driftOf` re-derives the comparison on every read and returns `unrendered`, `current`, ' +
    '`drifted` or `unknown`; a shot rendered before the field existed returns `unknown`, so it ' +
    'never reads as `current` or as `drifted`. Shot Coverage, the Stale branch and the approval ' +
    "queue call `driftOf` over every scene, keyed by a frame's image; `SlotState.drift` answers " +
    'only for the shot slots of live scenes. The ' +
    'value is derived rather than stored because `shotData` is rewritten wholesale each pass, ' +
    'and it is not the task hash, which is the hash prose cannot move. The hash walks ' +
    '`scene.lines`, so reordering `coversLines` does not count as an edit while extending ' +
    'coverage does, since the question is whether this frame illustrates the words it is ' +
    'against. Every surface that can change prose shows the author the sentence before the ' +
    "commit (`story.setLineText`'s `check`) and the mark after it. A bound generation graph is " +
    'the opposite case: editing one does invalidate the slot (`graphs.editInvalidates`).',
});

/**
 * Hash of what a shot's covered lines say, taken in scene order rather than `coversLines` order —
 * coverage is a set, and reordering the array is not a change to the prose.
 *
 * A coverage edit does move this hash, because it changes which words the frame is answerable for.
 * Extending a bracket over another line makes the frame no longer illustrate what it covers, in
 * exactly the sense a retype does.
 */
export function proseHash(scene: Scene, coversLines: readonly string[]): string {
  const covered = new Set(coversLines);
  return hashParts(scene.lines.filter((l) => covered.has(l.id)).map((l) => l.text));
}

/** Answers where a shot stands against its scene as loaded. Pure, and cheap enough for every read. */
export function driftOf(scene: Scene, shot: Shot): Drift {
  if (shot.image === undefined) return 'unrendered';
  if (shot.proseHash === undefined) return 'unknown';
  return shot.proseHash === proseHash(scene, shot.coversLines) ? 'current' : 'drifted';
}
