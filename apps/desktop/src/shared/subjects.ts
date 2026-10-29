/**
 * The kinds of subject a tour's `select` step may name, each with the data path that holds it
 * while it is selected and a sentence telling the agent what its key is.
 *
 * A step is met when its kind's path reads as its key, so a kind is listed only where the
 * selection holds the key itself. A location and a skill are left out, because each selects a
 * file looked up from its id. A wiki note is named as a `file`, by its full path.
 */
import type { Published } from './effects.js';

export interface Subject {
  /** The `ui.*` path that holds the subject while it is selected. */
  path: `ui.${Published}`;
  /** What the step's key is for this kind, as the agent is told it. */
  key: string;
}

export const SUBJECTS = Object.freeze({
  scene    : { path: 'ui.sceneId', key: 'the scene id' },
  // Assumes shot ids are unique across scenes: `<scene>__<raw>` is the generators' convention,
  // not a schema rule, so a hand-written `s1` in two scenes is met by either
  shot: {
    path: 'ui.shotId',
    key : 'the shot id as stored in work/shots/<scene>.json, e.g. greet__s1',
  },
  character: { path: 'ui.characterId', key: 'the character id' },
  asset    : { path: 'ui.assetHash', key: "the asset's content hash" },
  graph    : { path: 'ui.graphSlug', key: "the graph's slug, its file name under work/graphs/" },
  // One task, unlike the task cards' highlight, which lights every card about the selected shot
  // or character
  task     : { path: 'ui.taskHash', key: 'the task hash' },
  file     : { path: 'ui.docPath', key: 'the workspace-relative path, with no leading /' },
} satisfies Record<string, Subject>);

export type SubjectKind = keyof typeof SUBJECTS;

/** Returns the kinds a select step may name, in the table's order. */
export const subjectKinds = (): [SubjectKind, ...SubjectKind[]] =>
  Object.keys(SUBJECTS) as [SubjectKind, ...SubjectKind[]];

/** Looks up a kind, which arrives as text an agent wrote. */
export function subjectOf(kind: string): Subject | undefined {
  return Object.hasOwn(SUBJECTS, kind) ? SUBJECTS[kind as SubjectKind] : undefined;
}
