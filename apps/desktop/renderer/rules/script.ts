/**
 * The script editor's pure half. Nothing here reads the DOM or calls a command — the surface
 * asks it what a gesture means and then runs the command it names, so the mapping from an
 * authorial act to a `CommandRecord` is testable in node.
 *
 * This surface's model is a list of lines rather than a buffer, so a keystroke either belongs to
 * the textarea or names one command. Whether an edit is legal is decided by `@vn/scriptedit`,
 * through the command, and its sentence is what the author reads. This module only decides which
 * command an act asks for, and whether an act happened at all.
 */
import type { Invocation } from '@vn/commands';
import type { ScriptState } from '@vn/scriptedit';
import type { Scene } from '@vn/types';
import { TOP } from '../../src/shared/interactions.js';
import { commitOf, lineOf } from '../../src/shared/lineedit.js';
import type { CharacterEntry, CoverageLine, SceneCoverage, StoryGraph } from '../../src/shared/ipc';

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
 * The composer exists because `story.insertLine` refuses a line with no text ("A line needs some
 * text"); an empty line has no lossless Fountain form. Enter therefore cannot create the line
 * first and let the author type into it. Instead it opens a row that is not a line yet, and
 * committing that row performs the insert.
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
 * Where the editor goes once an act's commands have run. The caret lands at the end of whatever
 * opens, so each continuation keeps the author typing where the act left them.
 */
export type Continue =
  | { open: 'none' }
  /** Compose a line after this one. {@link COMPOSED} names the line that was just inserted. */
  | { open: 'compose'; after: string }
  /** Reopen an existing line's editor. */
  | { open: 'line'; line: string };

/**
 * Sentinel for the id of the line an `insertLine` just created. No pure function can know that
 * id — it is recovered after the reload, by {@link insertedAfter}. Safe as a sentinel because
 * every real line id is `<scene>:L<n>`.
 */
export const COMPOSED = 'composed';

/** What a keystroke means. `type` leaves the keystroke to the textarea. */
export type ScriptAct =
  | { act: 'type' }
  /** Close the editor and drop the draft. Nothing is written. */
  | { act: 'discard' }
  /**
   * Run these in order, stopping at the first refusal, then continue. `steps` may be empty when
   * there is nothing to write but the editor still moves.
   */
  | { act: 'run'; steps: Invocation[]; then: Continue };

const TYPE: ScriptAct = { act: 'type' };
const DISCARD: ScriptAct = { act: 'discard' };

/**
 * What a keystroke in the open editor asks for. Three keys are the surface's; everything else
 * belongs to the textarea.
 *
 * - Enter commits the row. At the end of a line it also opens a composer below, which is how a
 *   paragraph gets typed: one `setLineText` and one `insertLine` per line, each its own undo
 *   point. Mid-line it only commits, because inserting happens from the end of a line and a
 *   caret in the middle means the author was fixing that line.
 * - Backspace at the start of an emptied line is `story.deleteLine`: the author cleared the line
 *   and kept going, and `setLineText` would only refuse it ("delete it instead"). At the start of
 *   a line that still says something it does nothing — merging two lines is a delete plus a
 *   retype, and spending two commands on a keystroke that usually means a mis-hit is worse than
 *   doing nothing.
 * - Escape discards.
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
 * A parenthetical is a delivery note, so the line following one is the spoken line rather than a
 * second note.
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

/**
 * The row the editor moves to once an act's commands have run, and the draft it opens with —
 * resolved against the reloaded lines, because that is the only place the id an insert just
 * minted can be found. `null` closes the editor.
 *
 * `from` is `null` for an act no editor started — a drag commits a command too, and it has no row
 * to have come from.
 */
export function nextEditing(
  lines: readonly CoverageLine[],
  from: Editing | null,
  then: Continue,
): { editing: Editing; draft: string } | null {
  if (then.open === 'none') return null;
  if (then.open === 'line') {
    const line = lines.find((l) => l.id === then.line);
    return line ? { editing: { row: 'line', line }, draft: line.text } : null;
  }
  if (then.after !== COMPOSED) return { editing: { row: 'new', after: then.after }, draft: '' };
  const made = insertedAfter(lines, from?.row === 'new' ? from.after : '');
  return made ? { editing: { row: 'new', after: made.id }, draft: '' } : null;
}

/** One rendered row: a line of the scene, or the composer sitting after `after`. */
export type ScriptRow = { line: CoverageLine } | { compose: string };

/**
 * The column's rows, with the composer spliced in where it belongs. A composer whose `after`
 * names no line in the scene is dropped rather than floated to the end: its anchor line is gone,
 * and keeping the row would insert somewhere the author did not point.
 */
export function scriptRows(lines: readonly CoverageLine[], editing: Editing | null): ScriptRow[] {
  const after = editing?.row === 'new' ? editing.after : null;
  const rows: ScriptRow[] = after === '' ? [{ compose: '' }] : [];
  for (const line of lines) {
    rows.push({ line });
    if (after === line.id) rows.push({ compose: line.id });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Who says a line: the project's cast, offered as cues.
// ---------------------------------------------------------------------------

/** A cast member as the cue picker needs them — `WorkspaceIndex.characters`, narrowed. */
export type CastMember = Pick<CharacterEntry, 'id' | 'name'>;

/**
 * One option in a line's cue picker: the cue `story.setSpeaker` would be given, what the author
 * reads, and whether it is what the line already says.
 */
export interface CueChoice {
  /** A Fountain cue, or `''` for "no one" — which makes the line narration. */
  cue: string;
  label: string;
  /** Choosing this is not an authorial act: nothing about the line would change. */
  current: boolean;
}

/**
 * The cue for a cast member: their name, uppercased, which is what an author types in a Fountain
 * screenplay and what `buildModel` resolves back to this id. Deliberately not the id: a prose edit
 * is decided against the scene as its file parses, where speakers are still cues, so writing an id
 * back would rewrite `AIKO` as `@aiko`.
 */
export function cueFor(member: CastMember): string {
  return (member.name || member.id).toUpperCase();
}

/**
 * The cast member a line's speaker names, or `null`. A speaker is a resolved character id after
 * `buildModel` has seen it and the raw cue when it resolved to nothing, so both are matched.
 */
export function castFor(cast: readonly CastMember[], speaker?: string): CastMember | null {
  if (!speaker) return null;
  const cue = speaker.toUpperCase();
  return cast.find((m) => m.id === speaker || cueFor(m) === cue) ?? null;
}

/** What a row's cue slot shows: the cast member's name, an unresolved cue verbatim, or nothing. */
export function cueLabel(cast: readonly CastMember[], speaker?: string): string {
  if (!speaker) return '';
  return castFor(cast, speaker)?.name || speaker;
}

/**
 * A line's attribution options: the whole project cast, then the cue it already carries if that is
 * nobody in `characters/`, then "no one".
 *
 * The cast is the project's rather than the scene's — attributing a line is how a character gets
 * into a scene in the first place. An unresolved cue is offered so picking through the list cannot
 * silently discard a cue the author typed by hand; naming a character who does not exist yet is
 * not offered at all, because that is a `characters/` edit and this control writes prose.
 */
export function cueChoices(cast: readonly CastMember[], speaker?: string): CueChoice[] {
  const mine = castFor(cast, speaker);
  const choices: CueChoice[] = cast.map((m) => ({
    cue: cueFor(m),
    label: m.name || m.id,
    current: m === mine,
  }));
  if (speaker && !mine) {
    choices.push({ cue: speaker, label: `${speaker} — not in characters/`, current: true });
  }
  choices.push({ cue: '', label: 'no one (narration)', current: !speaker });
  return choices;
}

/** What the column calls a line nobody says. Never a cue — no cast member is spelled this way. */
export const NARRATOR = 'narrator';

/**
 * What a line's cue slot reads and what it says on hover. An unattributed line names the
 * narrator rather than showing nothing: a blank slot looks like the absence of a control, which
 * leaves an author with a scene of narration and no idea a speaker was ever theirs to set.
 */
export function cueSlotText(
  cast: readonly CastMember[],
  speaker?: string,
): { label: string; title: string } {
  const label = cueLabel(cast, speaker);
  return label
    ? { label, title: `${label} says this line — click to change who does` }
    : { label: NARRATOR, title: 'Nobody says this line — click to give it a speaker' };
}

/**
 * The cue slot's text for the composer row. The row has no line yet, so this states what the
 * insert will attribute rather than offering to change it. {@link attributionAfter} decides.
 */
export function composedCueText(
  cast: readonly CastMember[],
  above: CoverageLine | null,
): { label: string; title: string } {
  const label = cueLabel(cast, attributionAfter(above).speaker);
  return label
    ? { label, title: `${label} will say this line, like the one above it` }
    : {
        label: NARRATOR,
        title: 'This will be narration — say who speaks it once the line exists',
      };
}

/** `story.setSpeaker` as the column asks for it. An empty `speaker` makes the line narration. */
export const setSpeakerOf = (line: string, cue: string): Invocation => ({
  id: 'story.setSpeaker',
  props: { line, speaker: cue },
});

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
 * Midpoints are used rather than the gaps between rows because the gap is only a hairline —
 * too small a target for the author to aim at deliberately.
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
 * leave the head empty, which `splitScene` refuses, so offering it would only ever produce a
 * refusal.
 */
export function splitBoundaries(lines: readonly CoverageLine[]): string[] {
  return lines.slice(1).map((l) => l.id);
}

/**
 * An id for the tail of a split: the scene's own, suffixed, first one free. An already-suffixed
 * scene counts up rather than nesting — splitting `arrival_2` proposes `arrival_3`, not
 * `arrival_2_2`.
 *
 * The separator is an underscore because that is what `slug` produces, and `splitScene` refuses
 * anything that is not already its own slug. This is only a proposal — whether the id is free is
 * still decided by the command.
 */
export function proposeSceneId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = base.replace(/_\d+$/, '');
  for (let n = 2; ; n++) {
    const id = `${stem}_${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * The scene a merge at the end of `sceneId` would absorb — the one it continues to, and only when
 * that continuation is the scene's only way out. `null` when there is no boundary to remove.
 *
 * A merge always absorbs the scene this one continues to, which is the boundary at the bottom of
 * the column. The rest of the refusals (the entry scene, something else pointing at the absorbed
 * scene) are `mergeScene`'s, and the author reads them from its `check`.
 */
export function mergeTarget(story: StoryGraph, sceneId: string): string | null {
  const out = story.edges.filter((e) => e.from === sceneId);
  if (out.some((e) => e.kind === 'choice')) return null;
  const next = out.find((e) => e.kind === 'next' && !e.dangling);
  return next?.to ?? null;
}

/**
 * Whether a new scene may be written as this one's continuation — only from a leaf. On a scene
 * that already goes somewhere, continuing would replace that wire; putting a scene between two
 * others is the branch editor's splice gesture, which already exists and states its own cost.
 */
export function canContinue(story: StoryGraph, sceneId: string): boolean {
  return !story.edges.some((e) => e.from === sceneId);
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

/**
 * A structural act the author has asked for and not yet confirmed. Each of these moves lines
 * across a scene boundary or creates a file, and each carries a cost only the command can state —
 * so the column holds the invocation, shows that sentence, and commits on a second gesture.
 *
 * The editable fields live here rather than in the surface because they are props: what the
 * author is choosing before confirming is the invocation itself.
 */
export type Pending =
  /** Cut this scene in two at `at`; everything from there down moves into `into`. */
  | { act: 'split'; at: string; into: string }
  /** Absorb the scene this one continues to. */
  | { act: 'merge'; absorbed: string }
  /** Write a new scene and continue to it. */
  | { act: 'scene'; scene: string; heading: string };

/**
 * The new-scene act as the column proposes it: a free id derived from this scene's, and a heading
 * built from the current location. Both are prefills the author edits in the strip; a heading has
 * to be composed rather than copied, because what the column knows is the location id.
 */
export function continueFrom(scene: string, location: string, taken: Iterable<string>): Pending {
  return {
    act: 'scene',
    scene: proposeSceneId(scene, taken),
    heading: `INT. ${location.toUpperCase()} - DAY`,
  };
}

/**
 * The commands a pending act runs, in order. A new scene is two of them — `newScene` creates
 * something deliberately unreachable and `setNext` is what reaches it — because they are two
 * authorial facts and undoing the wire should not also delete the prose.
 */
export function stepsOf(pending: Pending, scene: string): Invocation[] {
  if (pending.act === 'split') return [splitOf(scene, pending.at, pending.into)];
  if (pending.act === 'merge') return [mergeOf(pending.absorbed, scene)];
  return [
    { id: 'story.newScene', props: { scene: pending.scene, heading: pending.heading } },
    { id: 'story.setNext', props: { scene, goto: pending.scene } },
  ];
}

/**
 * The invocation whose `check` is worth showing before a pending act commits — the first, which is
 * the one that carries the cost. A second step is asked about a scene that does not exist yet, so
 * its check could only report that.
 */
export function checkOf(pending: Pending, scene: string): Invocation {
  return stepsOf(pending, scene)[0] as Invocation;
}
