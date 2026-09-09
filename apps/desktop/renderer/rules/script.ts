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
import { isSpeakable, type ScriptState } from '@vn/scriptedit';
import type { Scene } from '@vn/types';
import { TOP } from '../../src/shared/interactions.js';
import { commitOf, lineOf } from '../../src/shared/lineedit.js';
import type { Offer } from './anchors.js';
import { cellAction, type StripAsset } from './assetstrip.js';
import { closePopup, openMenu, openPopup, startDrag, view } from './effects.js';
import type { EditorId } from '../../src/shared/editors.js';
import type { CharacterEntry, CoverageLine, SceneCoverage, StoryGraph } from '../../src/shared/ipc';

/**
 * The local part of a `${sceneId}:L<n>` id, for the sentences that name one line. The scene half
 * is already the column's heading, and repeating it in every sentence makes the ids unreadable.
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
      act  : 'run',
      steps: step ? [step] : [],
      then : atEnd ? { open: 'compose', after: editing.line.id } : { open: 'none' },
    };
  }

  if (key === 'Backspace' && draft.start === 0 && draft.end === 0 && !lineOf(draft.text)) {
    if (editing.row === 'new') return DISCARD;
    const above = lineAbove(scene.lines, editing.line.id);
    return {
      act  : 'run',
      steps: [{ id: 'story.deleteLine', props: { line: editing.line.id } }],
      then : above ? { open: 'line', line: above.id } : { open: 'none' },
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

/**
 * One rendered row: a line of the scene at its 1-based place in the page, or the composer sitting
 * after `after`. `at` counts lines only, so an open composer does not shift the numbers around it.
 */
export type ScriptRow = { line: CoverageLine; at: number } | { compose: string };

/**
 * The column's rows, with the composer spliced in where it belongs. A composer whose `after`
 * names no line in the scene is dropped rather than floated to the end: its anchor line is gone,
 * and keeping the row would insert somewhere the author did not point.
 */
export function scriptRows(lines: readonly CoverageLine[], editing: Editing | null): ScriptRow[] {
  const after = editing?.row === 'new' ? editing.after : null;
  const rows: ScriptRow[] = after === '' ? [{ compose: '' }] : [];
  for (const [i, line] of lines.entries()) {
    rows.push({ line, at: i + 1 });
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
    cue    : cueFor(m),
    label  : m.name || m.id,
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
  id   : 'story.setSpeaker',
  props: { line, speaker: cue },
});

/**
 * A line's cue slot: the button that names who says it, or the picker while it is open. The cue
 * is what the picker supplies, so the offer names the line alone. Keyed by the line, since the
 * page draws one slot per line beside one text control per line.
 */
export function speakerAction(
  line: Pick<CoverageLine, 'id' | 'speaker'>,
  cast: readonly CastMember[],
  picking: boolean,
): Offer {
  const { label, title } = cueSlotText(cast, line.speaker);
  return {
    ok   : true,
    id   : 'story.setSpeaker',
    props: { line: line.id },
    on   : line.id,
    label,
    tooltip : picking ? 'Who says this line — picking nobody makes it narration' : title,
    supplies: ['speaker'],
  };
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
    id        : coverage.sceneId,
    location  : coverage.location,
    characters: [],
    lines     : [...coverage.lines],
    choices   : [],
    shots     : [],
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
  id   : 'story.splitScene',
  props: { scene, at, into },
});

/** `story.mergeScene`: `absorbed`'s lines are appended to the scene that continues to it. */
export const mergeOf = (absorbed: string, into: string): Invocation => ({
  id   : 'story.mergeScene',
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
    act    : 'scene',
    scene  : proposeSceneId(scene, taken),
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

/**
 * What the script page reads when it draws its anchored controls. Named apart from
 * `@vn/scriptedit`'s `ScriptState`, which this module also imports.
 */
export interface ScriptPageState {
  /** The scene on the page, once loaded. A line with no `kind` is read as dialogue. */
  shown?: {
    sceneId: string;
    heading: string;
    lines: { id: string; text: string; kind?: CoverageLine['kind']; speaker?: string }[];
  };
  /** The line whose text box is open, which replaces that line's control with the box. */
  editingLine: string | null;
  /** The line a composer is open under, `''` for one at the head of the scene; none when unset. */
  composing?: string;
  /** The line whose cue picker is open, which changes that slot's tooltip. */
  attributing?: string | null;
  /** The project's cast, which the cue slots name. */
  cast?: readonly CastMember[];
  pending: Pending | null;
  /** The selected scene, or the empty string with none. */
  sceneId: string;
  /** The scene this one continues to, when `story.mergeScene` would take it; none otherwise. */
  absorb?: string;
  /** Whether a new scene can be written after this one. */
  continues?: boolean;
  /** The frames drawn from this scene, and the editors some pane shows, which routes a pick. */
  frames?: { assets: readonly StripAsset[]; visible: readonly EditorId[] };
}

/** The bar's scene picker, a drop-down of every scene in the story. */
export function pickerAction(sceneId: string): Offer {
  return {
    ok: true,
    ...openMenu('scenes'),
    label  : sceneId || 'scene…',
    tooltip: 'Which scene this editor shows. Every pane follows the choice.',
  };
}

/** The bar's `⟳`. */
export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : '⟳',
    tooltip: 'Re-read this scene from disk',
  };
}

/** The composer key for a row under `after`; `''` is the head of the scene. */
const composeKey = (after: string): string => `compose/${after || 'first'}`;

/** The invitation an empty scene draws, which opens a composer at its head. */
export function startAction(sceneId: string): Offer {
  return {
    ok: true,
    ...openPopup('box'),
    on     : composeKey(''),
    label  : `${sceneId} has no lines yet — write the first one.`,
    tooltip: 'Open a box and write the first line of this scene',
  };
}

/** `+ line`, which opens a composer under the last line. */
export function addLineAction(last: string): Offer {
  return {
    ok: true,
    ...openPopup('box'),
    on     : composeKey(last),
    label  : '+ line',
    tooltip: 'Write another line at the end of this scene',
  };
}

/**
 * The composer's box: the insert it commits, with the text as what the box supplies. The kind
 * and the speaker are derived from the line above at commit time, so the offer names neither.
 */
export function composeBox(sceneId: string, after: string): Offer {
  return {
    ok      : true,
    id      : 'story.insertLine',
    props   : { scene: sceneId, after },
    on      : composeKey(after),
    label   : 'Write the line, then Enter',
    tooltip : 'Write a new line — Enter writes it, Escape leaves the scene alone',
    supplies: ['text'],
  };
}

/** The box a line's text is retyped in, drawn in place of the line while it is open. */
export function lineBox(line: { id: string; text: string }): Offer {
  return {
    ...lineTextAction(line),
    on     : `${line.id}/box`,
    label  : `Retype ${line.id}`,
    tooltip: `Retype ${line.id} — Enter writes it, Escape leaves the line alone`,
  };
}

/** The gutter number, which is also the handle a line is dragged by. */
export function lidAction(line: { id: string }, at: number): Offer {
  return {
    ok: true,
    ...startDrag('script.moveLine'),
    on     : `line/${line.id}`,
    label  : String(at),
    tooltip: `Line ${at} of this scene, ${line.id} — drag this handle to move it`,
  };
}

/** `split here`, drawn on a row a split may start at while no act is pending. */
export function splitAction(lineId: string): Offer {
  return {
    ok: true,
    ...openPopup('box'),
    on     : `split/${lineId}`,
    label  : 'split here',
    tooltip: 'Start a second scene at this line, and name it before anything is written',
  };
}

/** `merge <scene> in`, drawn while `mergeTarget` names a scene. */
export function mergeAction(absorb: string): Offer {
  return {
    ok: true,
    ...openPopup('box'),
    on     : `merge/${absorb}`,
    label  : `merge ${absorb} in`,
    tooltip: `Take ${absorb}'s lines into this scene and delete its file`,
  };
}

/** `+ scene after this one`, drawn while `canContinue` allows it. */
export function continueAction(): Offer {
  return {
    ok: true,
    ...openPopup('box'),
    on     : 'continue',
    label  : '+ scene after this one',
    tooltip: 'Write a new scene and make this one continue into it',
  };
}

/** The pending strip's typed fields, by the prop each one fills. */
export type PendingField = 'into' | 'scene' | 'heading';

const FIELD_LABEL: Record<PendingField, string> = {
  into   : "The new scene's id",
  scene  : "The new scene's id",
  heading: "The new scene's heading",
};

/** One field of the pending strip, beside `pendingAction`. */
export function pendingBox(pending: Pending, sceneId: string, field: PendingField): Offer {
  return {
    ...pendingAction(pending, sceneId),
    on     : field,
    label  : FIELD_LABEL[field],
    tooltip: `${FIELD_LABEL[field]}. Enter confirms the act, Escape abandons it.`,
  };
}

/** The fields a pending act types into, in strip order. */
export function pendingFields(pending: Pending): PendingField[] {
  if (pending.act === 'split') return ['into'];
  if (pending.act === 'merge') return [];
  return ['scene', 'heading'];
}

/** The pending strip's Cancel. */
export function cancelAction(): Offer {
  return {
    ok: true,
    ...closePopup('box'),
    on     : 'cancel',
    label  : 'Cancel',
    tooltip: 'Abandon this act. Nothing is written.',
  };
}

/**
 * The heading as the scene's own slugline, and where the scene is moved from, because the heading
 * gives the location. Opens the dialog, which rechecks on every keystroke, so the price of the
 * move is on screen before it is made.
 */
export function headingAction(shown: { sceneId: string; heading: string }): Offer {
  return {
    ok     : true,
    id     : 'story.setHeading',
    props  : { scene: shown.sceneId, heading: shown.heading },
    label  : shown.heading,
    tooltip:
      'Move this scene somewhere else by rewriting its heading. Its rendered shots are drawn ' +
      'again — the dialog says how many — and the prose is left describing the old place.',
    form   : true,
  };
}

/**
 * One line's text. The click opens a box rather than writing anything, so the new text is what
 * the widget supplies. The line is named by its own id, which survives every re-sort of the scene.
 */
export function lineTextAction(line: { id: string; text: string }): Offer {
  return {
    ok      : true,
    id      : 'story.setLineText',
    props   : { line: line.id },
    label   : line.text,
    tooltip : 'Click to retype this line',
    on      : line.id,
    supplies: ['text'],
  };
}

/**
 * The strip's confirming button: the first step of the pending act, which is the one that
 * carries the cost. A new scene's second step, `story.setNext`, is run but not anchored.
 */
export function pendingAction(pending: Pending, sceneId: string): Offer {
  const step = checkOf(pending, sceneId);
  const label = pending.act === 'split' ? 'Split' : pending.act === 'merge' ? 'Merge' : 'Write it';
  const tooltip =
    pending.act === 'split'
      ? 'Cut the scene here and write the tail as its own file'
      : pending.act === 'merge'
        ? 'Fold that scene into this one and delete the file it came from'
        : 'Write the new scene and point this one at it';
  return { ok: true, id: step.id, props: step.props, label, tooltip };
}

/**
 * Every offer the script page draws from this module, in page order: the bar's picker and
 * reload; the heading; the invitation of an empty scene; per line its drag handle, its cue slot,
 * its text control or the box that replaces it while open, and `split here` where a split may
 * start; the composer's box while one is open; the structure buttons; the pending strip's
 * fields, button and Cancel while an act is pending over a scene; and the frames drawn from the
 * scene.
 */
export function controls(state: ScriptPageState): readonly Offer[] {
  const list: Offer[] = [pickerAction(state.sceneId), reloadAction()];
  const shown = state.shown;
  if (shown) {
    list.push(headingAction(shown));
    if (shown.lines.length === 0 && state.composing === undefined) {
      list.push(startAction(shown.sceneId));
    }
    if (state.composing === '') list.push(composeBox(shown.sceneId, ''));
    const cuts = new Set(splitBoundaries(shown.lines as CoverageLine[]));
    shown.lines.forEach((line, i) => {
      list.push(lidAction(line, i + 1));
      if (isSpeakable(line.kind ?? 'dialogue')) {
        list.push(speakerAction(line, state.cast ?? [], state.attributing === line.id));
      }
      list.push(line.id === state.editingLine ? lineBox(line) : lineTextAction(line));
      if (cuts.has(line.id) && state.pending === null) list.push(splitAction(line.id));
      if (state.composing === line.id) list.push(composeBox(shown.sceneId, line.id));
    });
    const last = shown.lines[shown.lines.length - 1];
    if (last) list.push(addLineAction(last.id));
    if (state.absorb) list.push(mergeAction(state.absorb));
    if (state.continues) list.push(continueAction());
  }
  if (state.pending && state.sceneId) {
    const pending = state.pending;
    list.push(...pendingFields(pending).map((field) => pendingBox(pending, state.sceneId, field)));
    list.push(pendingAction(pending, state.sceneId), cancelAction());
  }
  if (state.frames) {
    const visible = state.frames.visible;
    list.push(...state.frames.assets.map((asset) => cellAction(asset, visible)));
  }
  return list;
}
