/**
 * The script editor's pure half. Nothing here reads the DOM or calls a command — the surface
 * asks it what a gesture means and then runs the command it names, so the mapping from an
 * authorial act to a `CommandRecord` is testable in node.
 *
 * The rule the whole module exists to hold: this surface's model is a **list of lines**, not a
 * buffer, so a keystroke either belongs to the textarea or names one command. Nothing here
 * decides whether an edit is *legal* — `@vn/scriptedit` does, through the command, and its
 * sentence is what the author reads. What is decided here is which command an act asks for, and
 * whether an act happened at all.
 */
import type { Invocation } from '@vn/commands';
import type { ScriptState } from '@vn/scriptedit';
import type { Scene } from '@vn/types';
import { TOP } from '../../../../src/shared/interactions.js';
import { commitOf, lineOf } from '../../../../src/shared/lineedit.js';
import type { CoverageLine, SceneCoverage, StoryGraph } from '../../../../src/shared/ipc';

/**
 * The local part of a `${sceneId}:L<n>` id, which is what the gutter shows. The scene half is
 * already the column's heading, and repeating it on every row makes the numbers unreadable.
 */
export function localLineId(lineId: string): string {
  const colon = lineId.lastIndexOf(':');
  return colon < 0 ? lineId : lineId.slice(colon + 1);
}

/** The scene the column is showing, as much of it as this module reads. */
export interface ScriptScene {
  sceneId: string;
  lines: CoverageLine[];
}

/**
 * Which row's editor is open: an existing line being retyped, or a line that does not exist yet
 * being composed after `after` (`''` = the top of the scene).
 *
 * The composer is the answer to a rule the plan got wrong. `story.insertLine` refuses a line with
 * no text ("A line needs some text"), and it has to — an empty line has no lossless Fountain
 * form. So Enter cannot create the line and then let the author type into it. It opens a row that
 * is not a line yet, and committing that row is the insert.
 */
export type Editing = { row: 'line'; line: CoverageLine } | { row: 'new'; after: string };

/** A draft mid-typing: what the textarea holds and where its caret sits. */
export interface Draft {
  text: string;
  /** `selectionStart` / `selectionEnd`. A plain caret has both equal. */
  start: number;
  end: number;
}

/**
 * Where the editor goes once an act's commands have run. A caret lands at the end of whatever
 * opens — every continuation here is the author still moving the way they were typing.
 */
export type Continue =
  | { open: 'none' }
  /** Compose a line after this one. {@link COMPOSED} means "after the line just inserted". */
  | { open: 'compose'; after: string }
  /** Reopen an existing line's editor. */
  | { open: 'line'; line: string };

/**
 * Stands in for the id of the line an `insertLine` just created, which no pure function can know
 * — only the reload does, and {@link insertedAfter} is how. Safe as a sentinel because every real
 * line id is `<scene>:L<n>`.
 */
export const COMPOSED = 'composed';

/** What a keystroke means. `type` is "not ours — let the textarea have it". */
export type ScriptAct =
  | { act: 'type' }
  /** Close the editor and drop the draft. Nothing is written. */
  | { act: 'discard' }
  /**
   * Run these in order, stopping at the first refusal, then continue. `steps` may be empty —
   * "nothing to write, but the editor still moves".
   */
  | { act: 'run'; steps: Invocation[]; then: Continue };

const TYPE: ScriptAct = { act: 'type' };
const DISCARD: ScriptAct = { act: 'discard' };

/**
 * What a keystroke in the open editor asks for. Three keys are the surface's; everything else
 * belongs to the textarea.
 *
 * - **Enter** commits the row. At the end of a line it also opens a composer below, which is how
 *   a paragraph gets typed: one `setLineText` and one `insertLine` per line, each its own undo
 *   point. Mid-line it only commits — inserting happens from the end of a line, and a caret in
 *   the middle means "I was fixing this one".
 * - **Backspace** at the start of an *emptied* line is `story.deleteLine`: the author cleared the
 *   line and kept going, and `setLineText` would only refuse it ("delete it instead"). At the
 *   start of a line that still says something it does nothing — merging two lines is a delete
 *   plus a retype, and spending two commands on a keystroke that usually means "I mis-hit" is
 *   worse than doing nothing.
 * - **Escape** discards.
 *
 * There is no soft newline: a line with a newline in it is not one line (see `lineOf`), so a
 * modified Enter is still an Enter.
 */
export function keyAct(scene: ScriptScene, editing: Editing, draft: Draft, key: string): ScriptAct {
  if (key === 'Escape') return DISCARD;

  if (key === 'Enter') {
    if (editing.row === 'new') {
      const step = insertOf(scene, editing.after, draft.text);
      if (!step) return DISCARD;
      return { act: 'run', steps: [step], then: { open: 'compose', after: COMPOSED } };
    }
    const step = commitOf(editing.line, draft.text);
    const atEnd = draft.start === draft.end && draft.start === draft.text.length;
    return {
      act: 'run',
      steps: step ? [step] : [],
      then: atEnd ? { open: 'compose', after: editing.line.id } : { open: 'none' },
    };
  }

  if (key === 'Backspace' && draft.start === 0 && draft.end === 0 && !lineOf(draft.text)) {
    if (editing.row === 'new') return DISCARD;
    const above = lineAbove(scene.lines, editing.line.id);
    return {
      act: 'run',
      steps: [{ id: 'story.deleteLine', props: { line: editing.line.id } }],
      then: above ? { open: 'line', line: above.id } : { open: 'none' },
    };
  }

  return TYPE;
}

/** The line before `lineId` in scene order, or `null` when it is the first. */
export function lineAbove(lines: readonly CoverageLine[], lineId: string): CoverageLine | null {
  const at = lines.findIndex((l) => l.id === lineId);
  return at > 0 ? (lines[at - 1] as CoverageLine) : null;
}

/**
 * What a composed line inherits from the line above it. A dialogue block continues as dialogue
 * under the same cue — which is how a screenplay is typed — and everything else starts a
 * narration line, because `insertLine` refuses a speaker on a kind nobody speaks.
 *
 * A parenthetical is a delivery note, so the line *after* one is the spoken line, not a second
 * note.
 */
export function attributionAfter(above: CoverageLine | null): {
  kind: CoverageLine['kind'];
  speaker: string;
} {
  if (above && (above.kind === 'dialogue' || above.kind === 'parenthetical')) {
    return { kind: 'dialogue', speaker: above.speaker ?? '' };
  }
  return { kind: 'narration', speaker: '' };
}

/** The insert a composer row commits, or `null` when it holds nothing to insert. */
export function insertOf(scene: ScriptScene, after: string, draft: string): Invocation | null {
  const text = lineOf(draft);
  if (!text) return null;
  const above = after ? (scene.lines.find((l) => l.id === after) ?? null) : null;
  const { kind, speaker } = attributionAfter(above);
  return { id: 'story.insertLine', props: { scene: scene.sceneId, after, kind, speaker, text } };
}

/**
 * The line a composer at `after` just created, found in the reloaded scene — its position is what
 * identifies it, so the id never has to be read back out of a command's message.
 */
export function insertedAfter(lines: readonly CoverageLine[], after: string): CoverageLine | null {
  if (!after) return lines[0] ?? null;
  const at = lines.findIndex((l) => l.id === after);
  return at < 0 ? null : (lines[at + 1] ?? null);
}

// ---------------------------------------------------------------------------
// Dragging a line: where a drop lands, and the state `script.moveLine` is judged against.
// ---------------------------------------------------------------------------

/** One rendered row, as the column measures it. Viewport coordinates, in scene order. */
export interface RowBox {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The insertion point a drop at `y` means, named the way `script.moveLine` names its targets:
 * {@link TOP} above the first row's midpoint, otherwise the row whose lower half holds the
 * pointer.
 *
 * Midpoints rather than the gaps between rows, because that gap is a hairline — an insertion
 * point the author can only hit by accident is not one they can aim at.
 */
export function dropTarget(rows: readonly RowBox[], y: number): string {
  let target = TOP;
  for (const row of rows) {
    if (y >= (row.top + row.bottom) / 2) target = row.id;
  }
  return target;
}

/**
 * A one-scene `ScriptState` for `script.moveLine.targets`, so a drag can be judged per frame
 * without a round trip to main.
 *
 * Only a move is judged against it, and a move reads one scene's line order — exactly what
 * `SceneCoverage` carries. The line-id allocator is deliberately absent rather than invented: an
 * insert must go through the command, where the real high-water mark lives.
 */
export function moveStateOf(coverage: SceneCoverage): ScriptState {
  const scene: Scene = {
    id: coverage.sceneId,
    location: coverage.location,
    characters: [],
    lines: [...coverage.lines],
    choices: [],
    shots: [],
  };
  return { scenes: new Map([[scene.id, scene]]) };
}

// ---------------------------------------------------------------------------
// Split and merge: where a boundary can be put, and where one can be taken away.
// ---------------------------------------------------------------------------

/**
 * The lines a split may be offered at: every line but the first. Splitting at the first would
 * leave the head empty, which `splitScene` refuses — and an affordance that can only be refused
 * is worse than no affordance.
 */
export function splitBoundaries(lines: readonly CoverageLine[]): string[] {
  return lines.slice(1).map((l) => l.id);
}

/**
 * An id for the tail of a split: the scene's own, suffixed, first one free. An already-suffixed
 * scene counts up rather than nesting — splitting `arrival-2` proposes `arrival-3`, not
 * `arrival-2-2`.
 *
 * A proposal, not a decision: `splitScene` is the authority on whether an id is a slug and
 * whether it is taken.
 */
export function proposeSceneId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = base.replace(/-\d+$/, '');
  for (let n = 2; ; n++) {
    const id = `${stem}-${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * The scene a merge at the end of `sceneId` would absorb — the one it continues to, and only when
 * that continuation is the scene's only way out. `null` when there is no boundary to remove.
 *
 * A merge is always "absorb the scene I continue to", which is the boundary at the bottom of the
 * column. The rest of the refusals — the entry scene, something else pointing at the absorbed one
 * — are `mergeScene`'s, and the author reads them from its `check`.
 */
export function mergeTarget(story: StoryGraph, sceneId: string): string | null {
  const out = story.edges.filter((e) => e.from === sceneId);
  if (out.some((e) => e.kind === 'choice')) return null;
  const next = out.find((e) => e.kind === 'next' && !e.dangling);
  return next?.to ?? null;
}

/** `story.splitScene` as the column asks for it: `at` and everything below it move into `into`. */
export const splitOf = (scene: string, at: string, into: string): Invocation => ({
  id: 'story.splitScene',
  props: { scene, at, into },
});

/** `story.mergeScene`: `absorbed`'s lines are appended to the scene that continues to it. */
export const mergeOf = (absorbed: string, into: string): Invocation => ({
  id: 'story.mergeScene',
  props: { scene: absorbed, into },
});
