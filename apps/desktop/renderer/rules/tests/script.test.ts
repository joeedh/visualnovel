import { isSpeakable } from '@vn/scriptedit';
import { TOP, scriptMoveLine } from '../../../src/shared/interactions.js';
import {
  COMPOSED,
  NARRATOR,
  attributionAfter,
  canContinue,
  castFor,
  checkOf,
  composedCueText,
  continueFrom,
  cueChoices,
  cueFor,
  cueLabel,
  cueSlotText,
  dropTarget,
  insertOf,
  insertedAfter,
  keyAct,
  localLineId,
  mergeTarget,
  moveStateOf,
  nextEditing,
  proposeSceneId,
  scriptRows,
  setSpeakerOf,
  splitBoundaries,
  stepsOf,
  type CastMember,
  type Draft,
  type Pending,
} from '../script.js';
import type { Invocation } from '@vn/commands';
import type { CoverageLine, SceneCoverage, StoryEdge, StoryGraph } from '../../../src/shared/ipc';

const lines: CoverageLine[] = [
  { id: 'a:L1', kind: 'narration', text: 'The gate stands open.' },
  { id: 'a:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 'a:L3', kind: 'parenthetical', speaker: 'aiko', text: 'quietly' },
  { id: 'a:L4', kind: 'transition', text: 'CUT TO:' },
];
const scene = { sceneId: 'a', lines };
const at = (text: string, caret = text.length): Draft => ({ text, start: caret, end: caret });

describe('localLineId', () => {
  it('drops the scene half, which is the column heading', () => {
    expect(localLineId('arrival:L4')).toBe('L4');
  });

  it('keeps an id it cannot split rather than showing an empty gutter', () => {
    expect(localLineId('L4')).toBe('L4');
  });

  it('splits at the last colon, so a scene id containing one still resolves', () => {
    expect(localLineId('act1:arrival:L12')).toBe('L12');
  });
});

describe('keyAct on an open line', () => {
  const editing = { row: 'line', line: lines[1] as CoverageLine } as const;

  it('discards on Escape without writing anything', () => {
    expect(keyAct(scene, editing, at('Um… hi.'), 'Escape')).toEqual({ act: 'discard' });
  });

  it('commits and opens a composer below when Enter comes at the end', () => {
    expect(keyAct(scene, editing, at('Um… hi.'), 'Enter')).toEqual({
      act: 'run',
      steps: [{ id: 'story.setLineText', props: { line: 'a:L2', text: 'Um… hi.' } }],
      then: { open: 'compose', after: 'a:L2' },
    });
  });

  // The editor still moves: an author who clicked in, changed nothing and hit Enter asked for a
  // new line, and an undo point that undoes nothing is not the price of getting one.
  it('opens the composer with no steps when the draft says what the line already said', () => {
    expect(keyAct(scene, editing, at('Um… hello.'), 'Enter')).toEqual({
      act: 'run',
      steps: [],
      then: { open: 'compose', after: 'a:L2' },
    });
  });

  it('only commits when Enter comes mid-line', () => {
    expect(keyAct(scene, editing, at('Um… hi.', 3), 'Enter')).toEqual({
      act: 'run',
      steps: [{ id: 'story.setLineText', props: { line: 'a:L2', text: 'Um… hi.' } }],
      then: { open: 'none' },
    });
  });

  it('deletes an emptied line on Backspace and reopens the one above', () => {
    expect(keyAct(scene, editing, at('  ', 0), 'Backspace')).toEqual({
      act: 'run',
      steps: [{ id: 'story.deleteLine', props: { line: 'a:L2' } }],
      then: { open: 'line', line: 'a:L1' },
    });
  });

  it('has nowhere to reopen when the emptied line was the first', () => {
    const first = { row: 'line', line: lines[0] as CoverageLine } as const;
    expect(keyAct(scene, first, at(''), 'Backspace')).toEqual({
      act: 'run',
      steps: [{ id: 'story.deleteLine', props: { line: 'a:L1' } }],
      then: { open: 'none' },
    });
  });

  /**
   * The rule that keeps this from becoming a buffer: Backspace at the start of a line that still
   * says something is not "merge me into the line above" — it is a mis-hit.
   */
  it('does nothing on Backspace at the start of a line that still says something', () => {
    expect(keyAct(scene, editing, at('Um… hello.', 0), 'Backspace')).toEqual({ act: 'type' });
  });

  it('leaves an ordinary Backspace to the textarea', () => {
    expect(keyAct(scene, editing, at('  ', 2), 'Backspace')).toEqual({ act: 'type' });
    expect(keyAct(scene, editing, { text: '  ', start: 0, end: 2 }, 'Backspace')).toEqual({
      act: 'type',
    });
  });

  it('leaves every other key alone', () => {
    expect(keyAct(scene, editing, at('Um…'), 'a')).toEqual({ act: 'type' });
    expect(keyAct(scene, editing, at('Um…'), 'Tab')).toEqual({ act: 'type' });
  });
});

describe('keyAct on a composer row', () => {
  it('inserts what was typed and opens the next composer under it', () => {
    const editing = { row: 'new', after: 'a:L2' } as const;
    expect(keyAct(scene, editing, at('You came.'), 'Enter')).toEqual({
      act: 'run',
      steps: [
        {
          id: 'story.insertLine',
          props: {
            scene: 'a',
            after: 'a:L2',
            kind: 'dialogue',
            speaker: 'aiko',
            text: 'You came.',
          },
        },
      ],
      then: { open: 'compose', after: COMPOSED },
    });
  });

  // An empty composer is not a line yet, so there is nothing to delete and nothing to insert —
  // both keys just close the row.
  it('closes an empty row on Enter or Backspace without a command', () => {
    const editing = { row: 'new', after: '' } as const;
    expect(keyAct(scene, editing, at('   '), 'Enter')).toEqual({ act: 'discard' });
    expect(keyAct(scene, editing, at(''), 'Backspace')).toEqual({ act: 'discard' });
  });
});

describe('attributionAfter', () => {
  it('continues a dialogue block under the same cue', () => {
    expect(attributionAfter(lines[1] as CoverageLine)).toEqual({
      kind: 'dialogue',
      speaker: 'aiko',
    });
  });

  it('follows a parenthetical with the spoken line, not another note', () => {
    expect(attributionAfter(lines[2] as CoverageLine)).toEqual({
      kind: 'dialogue',
      speaker: 'aiko',
    });
  });

  it('starts narration after anything nobody speaks, and at the top of a scene', () => {
    expect(attributionAfter(lines[0] as CoverageLine)).toEqual({ kind: 'narration', speaker: '' });
    expect(attributionAfter(lines[3] as CoverageLine)).toEqual({ kind: 'narration', speaker: '' });
    expect(attributionAfter(null)).toEqual({ kind: 'narration', speaker: '' });
  });
});

describe('insertOf', () => {
  it('inserts at the top of the scene when there is nothing above', () => {
    expect(insertOf(scene, '', 'Rain, at first.')).toEqual({
      id: 'story.insertLine',
      props: { scene: 'a', after: '', kind: 'narration', speaker: '', text: 'Rain, at first.' },
    });
  });

  it('folds a pasted newline, because a line with a newline in it is not one line', () => {
    expect(insertOf(scene, '', 'Rain,\nat first.')?.props.text).toBe('Rain, at first.');
  });

  it('asks for nothing when the row holds nothing', () => {
    expect(insertOf(scene, 'a:L2', '  \n ')).toBeNull();
  });
});

describe('insertedAfter', () => {
  it('finds the line a composer just created by its position', () => {
    expect(insertedAfter(lines, 'a:L1')?.id).toBe('a:L2');
    expect(insertedAfter(lines, '')?.id).toBe('a:L1');
  });

  it('answers null when the insert did not land where the composer was', () => {
    expect(insertedAfter(lines, 'a:L4')).toBeNull();
    expect(insertedAfter(lines, 'a:L9')).toBeNull();
    expect(insertedAfter([], '')).toBeNull();
  });
});

describe('nextEditing', () => {
  it('opens a composer under the line an insert just minted, found by position', () => {
    const grown = [...lines];
    grown.splice(2, 0, { id: 'a:L7', kind: 'dialogue', speaker: 'aiko', text: 'You came.' });
    expect(
      nextEditing(grown, { row: 'new', after: 'a:L2' }, { open: 'compose', after: COMPOSED }),
    ).toEqual({ editing: { row: 'new', after: 'a:L7' }, draft: '' });
  });

  it('reopens a line with its own text as the draft', () => {
    expect(
      nextEditing(
        lines,
        { row: 'line', line: lines[1] as CoverageLine },
        {
          open: 'line',
          line: 'a:L1',
        },
      ),
    ).toEqual({ editing: { row: 'line', line: lines[0] }, draft: 'The gate stands open.' });
  });

  it('closes rather than guess when the line it would open is gone', () => {
    const from = { row: 'line', line: lines[1] as CoverageLine } as const;
    expect(nextEditing(lines, from, { open: 'line', line: 'a:L9' })).toBeNull();
    expect(nextEditing(lines, from, { open: 'none' })).toBeNull();
  });

  // A drop commits a command with no editor open, so there is no row it came from.
  it('takes no `from` for an act no editor started', () => {
    expect(nextEditing(lines, null, { open: 'none' })).toBeNull();
    expect(nextEditing(lines, null, { open: 'line', line: 'a:L3' })).toEqual({
      editing: { row: 'line', line: lines[2] },
      draft: 'quietly',
    });
  });
});

describe('scriptRows', () => {
  it('splices the composer in where it was opened', () => {
    expect(scriptRows(lines, { row: 'new', after: 'a:L2' })[2]).toEqual({ compose: 'a:L2' });
    expect(scriptRows(lines, { row: 'new', after: '' })[0]).toEqual({ compose: '' });
    expect(scriptRows(lines, { row: 'new', after: '' })).toHaveLength(lines.length + 1);
  });

  it('shows only lines while a line is being retyped, or nothing is', () => {
    expect(scriptRows(lines, { row: 'line', line: lines[1] as CoverageLine })).toHaveLength(
      lines.length,
    );
    expect(scriptRows(lines, null)).toHaveLength(lines.length);
  });

  // The line it was anchored to is gone, and a row that has forgotten where it is would insert
  // somewhere the author never pointed.
  it('drops a composer anchored to a line that is no longer there', () => {
    expect(scriptRows(lines, { row: 'new', after: 'a:L9' })).toHaveLength(lines.length);
  });
});

describe('dropTarget', () => {
  const rows = [
    { id: 'a:L1', top: 0, bottom: 20 },
    { id: 'a:L2', top: 20, bottom: 60 },
    { id: 'a:L3', top: 60, bottom: 80 },
  ];

  it('names the top insertion point above the first row’s midpoint', () => {
    expect(dropTarget(rows, 0)).toBe(TOP);
    expect(dropTarget(rows, 9)).toBe(TOP);
  });

  it('lands after the row whose lower half holds the pointer', () => {
    expect(dropTarget(rows, 10)).toBe('a:L1');
    expect(dropTarget(rows, 39)).toBe('a:L1');
    expect(dropTarget(rows, 40)).toBe('a:L2');
  });

  it('lands after the last row below every midpoint', () => {
    expect(dropTarget(rows, 500)).toBe('a:L3');
    expect(dropTarget([], 500)).toBe(TOP);
  });
});

describe('moveStateOf', () => {
  const coverage: SceneCoverage = {
    sceneId: 'a',
    location: 'gate',
    heading: 'INT. GATE - DAY',
    lines,
    shots: [],
    cast: [],
    decomposed: false,
  };

  it('invents no line-id allocator — an insert has to go through the command', () => {
    expect(moveStateOf(coverage).scenes.get('a')?.nextLineId).toBeUndefined();
  });

  /**
   * The point of the synthetic state: the *real* interaction judges a drag against it, so a
   * verdict drawn during the gesture is the one `story.moveLine` would produce.
   */
  it('is enough for script.moveLine to judge a drag', () => {
    const verdicts = scriptMoveLine.targets(moveStateOf(coverage), 'a:L2');
    expect(verdicts.find((v) => v.target === TOP)).toEqual({
      target: TOP,
      accept: true,
      note: 'Moved a:L2 to the top in a.',
      invoke: { id: 'story.moveLine', props: { line: 'a:L2', after: '' } },
    });
    // Dropping where it already sits reorders nothing, so it is not a target at all.
    expect(verdicts.map((v) => v.target)).not.toContain('a:L1');
  });
});

/**
 * The composition the column performs per pointer move, with the DOM read stubbed out: measured
 * rows → `dropTarget` → the verdict judged on the grab. Nothing else decides anything, which is
 * why the surface can stay thin.
 */
describe('a drag, from a pointer position to an invocation', () => {
  const coverage: SceneCoverage = {
    sceneId: 'a',
    location: 'gate',
    heading: 'INT. GATE - DAY',
    lines,
    shots: [],
    cast: [],
    decomposed: false,
  };
  const boxes = lines.map((l, i) => ({ id: l.id, top: i * 20, bottom: i * 20 + 20 }));
  const dropAt = (carried: string, y: number) => {
    const verdicts = new Map(
      scriptMoveLine.targets(moveStateOf(coverage), carried).map((v) => [v.target, v]),
    );
    return verdicts.get(dropTarget(boxes, y)) ?? null;
  };

  const commits = (carried: string, y: number): Invocation | null => {
    const verdict = dropAt(carried, y);
    return verdict?.accept ? verdict.invoke : null;
  };

  it('commits the verdict the drop lands on', () => {
    expect(commits('a:L4', 5)).toEqual({
      id: 'story.moveLine',
      props: { line: 'a:L4', after: '' },
    });
    // y=50 is past L3's midpoint, so the insertion point is "after a:L3".
    expect(commits('a:L1', 50)).toEqual({
      id: 'story.moveLine',
      props: { line: 'a:L1', after: 'a:L3' },
    });
  });

  it('finds no verdict where the drop would reorder nothing', () => {
    // Over its own row, and over the point just above it — both leave the order as it was.
    expect(dropAt('a:L2', 30)).toBeNull();
    expect(dropAt('a:L2', 10)).toBeNull();
  });
});

describe('the cue picker', () => {
  const cast: CastMember[] = [
    { id: 'aiko', name: 'Aiko' },
    { id: 'tanaka', name: 'Mr. Tanaka' },
  ];

  it('offers a cue, not an id — a prose edit is written back as the author would type it', () => {
    expect(cueFor(cast[0] as CastMember)).toBe('AIKO');
    expect(cueFor({ id: 'ghost', name: '' })).toBe('GHOST');
  });

  it('resolves a speaker whether it is an id or the raw cue that resolved to nothing', () => {
    expect(castFor(cast, 'aiko')?.id).toBe('aiko');
    expect(castFor(cast, 'AIKO')?.id).toBe('aiko');
    expect(castFor(cast, 'Mr. Tanaka')?.id).toBe('tanaka');
    expect(castFor(cast, 'kenji')).toBeNull();
    expect(castFor(cast, undefined)).toBeNull();
  });

  it('labels a row with the cast name it resolves to, and an unknown cue verbatim', () => {
    expect(cueLabel(cast, 'aiko')).toBe('Aiko');
    expect(cueLabel(cast, 'KENJI')).toBe('KENJI');
    expect(cueLabel(cast, undefined)).toBe('');
  });

  it('offers the whole cast plus "no one", with the line\'s own cue marked current', () => {
    expect(cueChoices(cast, 'aiko')).toEqual([
      { cue: 'AIKO', label: 'Aiko', current: true },
      { cue: 'MR. TANAKA', label: 'Mr. Tanaka', current: false },
      { cue: '', label: 'no one (narration)', current: false },
    ]);
  });

  it('marks "no one" current on a narration line, so re-picking it is not an act', () => {
    const choices = cueChoices(cast, undefined);
    expect(choices.filter((c) => c.current)).toEqual([
      { cue: '', label: 'no one (narration)', current: true },
    ]);
  });

  it('keeps an unresolved cue in the list, so picking through it cannot discard one', () => {
    expect(cueChoices(cast, 'KENJI')).toContainEqual({
      cue: 'KENJI',
      label: 'KENJI — not in characters/',
      current: true,
    });
  });

  it('asks for `story.setSpeaker`, and for narration with an empty cue', () => {
    expect(setSpeakerOf('a:L1', 'AIKO')).toEqual({
      id: 'story.setSpeaker',
      props: { line: 'a:L1', speaker: 'AIKO' },
    });
    expect(setSpeakerOf('a:L2', '').props).toEqual({ line: 'a:L2', speaker: '' });
  });

  it('offers the picker only where `setSpeaker` would act — its own predicate', () => {
    expect(lines.filter((l) => isSpeakable(l.kind)).map((l) => l.id)).toEqual([
      'a:L1',
      'a:L2',
      'a:L3',
    ]);
  });

  it('names the narrator on an unattributed line rather than showing an empty slot', () => {
    // A blank slot reads as "there is no control here", and the control is the whole point.
    expect(cueSlotText(cast, undefined)).toEqual({
      label: NARRATOR,
      title: expect.stringContaining('give it a speaker'),
    });
    expect(cueSlotText(cast, 'aiko').label).toBe('Aiko');
    expect(cueSlotText(cast, 'aiko').title).toContain('change who does');
  });

  it('says what the composer will attribute, which is not something it can change', () => {
    const dialogue: CoverageLine = { id: 'a:L2', kind: 'dialogue', speaker: 'aiko', text: 'Hi.' };
    expect(composedCueText(cast, dialogue)).toEqual({
      label: 'Aiko',
      title: expect.stringContaining('like the one above it'),
    });
    // Under narration, and at the top of a scene, the new line is narration too.
    expect(composedCueText(cast, lines[0] as CoverageLine).label).toBe(NARRATOR);
    expect(composedCueText(cast, null).label).toBe(NARRATOR);
    expect(composedCueText(cast, null).title).toContain('once the line exists');
  });
});

describe('splitBoundaries', () => {
  it('offers every line but the first, which would leave the head empty', () => {
    expect(splitBoundaries(lines)).toEqual(['a:L2', 'a:L3', 'a:L4']);
    expect(splitBoundaries(lines.slice(0, 1))).toEqual([]);
    expect(splitBoundaries([])).toEqual([]);
  });
});

describe('proposeSceneId', () => {
  it('suffixes the scene being split', () => {
    expect(proposeSceneId('arrival', ['arrival'])).toBe('arrival_2');
  });

  it('counts past ids already taken', () => {
    expect(proposeSceneId('arrival', ['arrival', 'arrival_2', 'arrival_3'])).toBe('arrival_4');
  });

  it('counts up from an already-suffixed scene rather than nesting', () => {
    expect(proposeSceneId('arrival_2', ['arrival', 'arrival_2'])).toBe('arrival_3');
  });
});

describe('mergeTarget', () => {
  const graph = (edges: StoryEdge[]): StoryGraph => ({ scenes: [], edges, diagnostics: [] });
  const next = (from: string, to: string, dangling = false): StoryEdge => ({
    id: `${from}#next`,
    from,
    to,
    kind: 'next',
    dangling,
  });

  it('names the scene this one continues to', () => {
    expect(mergeTarget(graph([next('a', 'b')]), 'a')).toBe('b');
  });

  it('refuses to name one where the scene forks — a merge only removes a boundary', () => {
    const choice: StoryEdge = {
      id: 'a#choice:0',
      from: 'a',
      to: 'b',
      kind: 'choice',
      label: 'Go in',
      index: 0,
      dangling: false,
    };
    expect(mergeTarget(graph([choice, next('a', 'c')]), 'a')).toBeNull();
  });

  it('has no boundary to remove at a leaf, or across a dangling edge', () => {
    expect(mergeTarget(graph([next('a', 'b')]), 'b')).toBeNull();
    expect(mergeTarget(graph([next('a', 'nowhere', true)]), 'a')).toBeNull();
  });
});

describe('canContinue', () => {
  const graph = (edges: StoryEdge[]): StoryGraph => ({ scenes: [], edges, diagnostics: [] });
  const edge = (from: string, kind: StoryEdge['kind']): StoryEdge => ({
    id: `${from}#${kind}`,
    from,
    to: 'b',
    kind,
    dangling: false,
  });

  it('offers a continuation only from a leaf', () => {
    expect(canContinue(graph([]), 'a')).toBe(true);
    expect(canContinue(graph([edge('a', 'next')]), 'a')).toBe(false);
  });

  it('counts a fork as a way out too — a choice is not a wire to replace', () => {
    expect(canContinue(graph([edge('a', 'choice')]), 'a')).toBe(false);
  });

  it('says nothing about edges into the scene: only what leaves it is in the way', () => {
    expect(canContinue(graph([edge('z', 'next')]), 'a')).toBe(true);
  });
});

describe('continueFrom', () => {
  it('proposes a free id and a heading composed from the location id', () => {
    expect(continueFrom('arrival', 'gate', ['arrival'])).toEqual({
      act: 'scene',
      scene: 'arrival_2',
      heading: 'INT. GATE - DAY',
    });
  });
});

describe('stepsOf', () => {
  it('splits with one command, against the scene the column is showing', () => {
    expect(stepsOf({ act: 'split', at: 'a:L3', into: 'a_2' }, 'a')).toEqual([
      { id: 'story.splitScene', props: { scene: 'a', at: 'a:L3', into: 'a_2' } },
    ]);
  });

  it('merges *into* the shown scene — the absorbed one is the argument', () => {
    expect(stepsOf({ act: 'merge', absorbed: 'b' }, 'a')).toEqual([
      { id: 'story.mergeScene', props: { scene: 'b', into: 'a' } },
    ]);
  });

  it('writes a new scene and wires it as two acts, in that order', () => {
    expect(stepsOf({ act: 'scene', scene: 'b', heading: 'INT. HALL - DAY' }, 'a')).toEqual([
      { id: 'story.newScene', props: { scene: 'b', heading: 'INT. HALL - DAY' } },
      { id: 'story.setNext', props: { scene: 'a', goto: 'b' } },
    ]);
  });
});

describe('checkOf', () => {
  it('asks the step that carries the cost — the first one', () => {
    const pending: Pending = { act: 'scene', scene: 'b', heading: 'INT. HALL - DAY' };
    expect(checkOf(pending, 'a')).toEqual(stepsOf(pending, 'a')[0]);
    expect(checkOf({ act: 'merge', absorbed: 'b' }, 'a').id).toBe('story.mergeScene');
  });
});
