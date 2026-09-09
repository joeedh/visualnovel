import { isSpeakable } from '@vn/scriptedit';
import { TOP, scriptMoveLine } from '../../../src/shared/interactions.js';
import {
  startAction,
  splitAction,
  reloadAction,
  pickerAction,
  pendingFields,
  pendingBox,
  mergeAction,
  lineBox,
  lidAction,
  continueAction,
  composeBox,
  cancelAction,
  addLineAction,
  speakerAction,
  COMPOSED,
  NARRATOR,
  attributionAfter,
  canContinue,
  castFor,
  checkOf,
  composedCueText,
  controls,
  continueFrom,
  cueChoices,
  cueFor,
  cueLabel,
  cueSlotText,
  dropTarget,
  headingAction,
  insertOf,
  insertedAfter,
  keyAct,
  lineTextAction,
  localLineId,
  mergeTarget,
  moveStateOf,
  nextEditing,
  pendingAction,
  proposeSceneId,
  scriptRows,
  setSpeakerOf,
  splitBoundaries,
  stepsOf,
  type CastMember,
  type Draft,
  type ScriptPageState,
  type Pending,
} from '../script.js';
import { duplicateKeys, keyOf } from '../anchors.js';
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

  it('keeps an id it cannot split rather than naming nothing', () => {
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
      act  : 'run',
      steps: [{ id: 'story.setLineText', props: { line: 'a:L2', text: 'Um… hi.' } }],
      then : { open: 'compose', after: 'a:L2' },
    });
  });

  // An author who clicked in, changed nothing and hit Enter asked for a new line, so the composer
  // opens without recording an undo point that would undo nothing
  it('opens the composer with no steps when the draft says what the line already said', () => {
    expect(keyAct(scene, editing, at('Um… hello.'), 'Enter')).toEqual({
      act  : 'run',
      steps: [],
      then : { open: 'compose', after: 'a:L2' },
    });
  });

  it('only commits when Enter comes mid-line', () => {
    expect(keyAct(scene, editing, at('Um… hi.', 3), 'Enter')).toEqual({
      act  : 'run',
      steps: [{ id: 'story.setLineText', props: { line: 'a:L2', text: 'Um… hi.' } }],
      then : { open: 'none' },
    });
  });

  it('deletes an emptied line on Backspace and reopens the one above', () => {
    expect(keyAct(scene, editing, at('  ', 0), 'Backspace')).toEqual({
      act  : 'run',
      steps: [{ id: 'story.deleteLine', props: { line: 'a:L2' } }],
      then : { open: 'line', line: 'a:L1' },
    });
  });

  it('has nowhere to reopen when the emptied line was the first', () => {
    const first = { row: 'line', line: lines[0] as CoverageLine } as const;
    expect(keyAct(scene, first, at(''), 'Backspace')).toEqual({
      act  : 'run',
      steps: [{ id: 'story.deleteLine', props: { line: 'a:L1' } }],
      then : { open: 'none' },
    });
  });

  // Backspace at the start of a line that still says something is a mis-hit, not a request to
  // merge it into the line above
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
      act  : 'run',
      steps: [
        {
          id   : 'story.insertLine',
          props: {
            scene  : 'a',
            after  : 'a:L2',
            kind   : 'dialogue',
            speaker: 'aiko',
            text   : 'You came.',
          },
        },
      ],
      then : { open: 'compose', after: COMPOSED },
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
      kind   : 'dialogue',
      speaker: 'aiko',
    });
  });

  it('follows a parenthetical with the spoken line, not another note', () => {
    expect(attributionAfter(lines[2] as CoverageLine)).toEqual({
      kind   : 'dialogue',
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
      id   : 'story.insertLine',
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
      draft  : 'quietly',
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

  // The line it was anchored to is gone, and a composer with no anchor would insert somewhere the
  // author never pointed
  it('drops a composer anchored to a line that is no longer there', () => {
    expect(scriptRows(lines, { row: 'new', after: 'a:L9' })).toHaveLength(lines.length);
  });

  it('numbers the lines from one, in the order they are read', () => {
    expect(scriptRows(lines, null).map((r) => ('line' in r ? r.at : 'composer'))).toEqual(
      lines.map((_, i) => i + 1),
    );
  });

  // The number is the row's place among the lines, and a composer is not a line yet
  it('counts past an open composer without renumbering the lines around it', () => {
    const rows = scriptRows(lines, { row: 'new', after: 'a:L1' });
    expect(rows[1]).toEqual({ compose: 'a:L1' });
    expect(rows[2]).toEqual({ line: lines[1], at: 2 });
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
    sceneId : 'a',
    location: 'gate',
    heading : 'INT. GATE - DAY',
    lines,
    shots     : [],
    cast      : [],
    characters: [],
    variants  : ['day'],
    decomposed: false,
  };

  it('invents no line-id allocator — an insert has to go through the command', () => {
    expect(moveStateOf(coverage).scenes.get('a')?.nextLineId).toBeUndefined();
  });

  // The real interaction judges a drag against this synthetic state, so a verdict drawn during the
  // gesture is the one `story.moveLine` would produce
  it('is enough for script.moveLine to judge a drag', () => {
    const verdicts = scriptMoveLine.targets(moveStateOf(coverage), 'a:L2');
    expect(verdicts.find((v) => v.target === TOP)).toEqual({
      target: TOP,
      accept: true,
      note  : 'Moved a:L2 to the top in a.',
      invoke: { id: 'story.moveLine', props: { line: 'a:L2', after: '' } },
    });
    // Dropping where it already sits reorders nothing, so it is not a target at all.
    expect(verdicts.map((v) => v.target)).not.toContain('a:L1');
  });
});

// The composition the column performs per pointer move, with the DOM read stubbed out: measured
// rows → `dropTarget` → the verdict judged on the grab. Nothing else decides anything, so the
// surface stays thin
describe('a drag, from a pointer position to an invocation', () => {
  const coverage: SceneCoverage = {
    sceneId : 'a',
    location: 'gate',
    heading : 'INT. GATE - DAY',
    lines,
    shots     : [],
    cast      : [],
    characters: [],
    variants  : ['day'],
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
      id   : 'story.moveLine',
      props: { line: 'a:L4', after: '' },
    });
    // y=50 is past L3's midpoint, so the insertion point is "after a:L3".
    expect(commits('a:L1', 50)).toEqual({
      id   : 'story.moveLine',
      props: { line: 'a:L1', after: 'a:L3' },
    });
  });

  it('finds no verdict where the drop would reorder nothing', () => {
    // Dropping the line over its own row, or over the point just above it, leaves the order as it was.
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
      cue    : 'KENJI',
      label  : 'KENJI — not in characters/',
      current: true,
    });
  });

  it('asks for `story.setSpeaker`, and for narration with an empty cue', () => {
    expect(setSpeakerOf('a:L1', 'AIKO')).toEqual({
      id   : 'story.setSpeaker',
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
    // A blank slot reads as if there were no control there, so the narrator is named instead
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
      id      : 'a#choice:0',
      from    : 'a',
      to      : 'b',
      kind    : 'choice',
      label   : 'Go in',
      index   : 0,
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
      act    : 'scene',
      scene  : 'arrival_2',
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

describe('headingAction', () => {
  it('opens the move dialog on the scene, prefilled with its heading', () => {
    expect(headingAction({ sceneId: 'a', heading: 'INT. HALL - DAY' })).toEqual({
      ok     : true,
      id     : 'story.setHeading',
      props  : { scene: 'a', heading: 'INT. HALL - DAY' },
      label  : 'INT. HALL - DAY',
      tooltip:
        'Move this scene somewhere else by rewriting its heading. Its rendered shots are drawn ' +
        'again — the dialog says how many — and the prose is left describing the old place.',
      form   : true,
    });
  });
});

describe('lineTextAction', () => {
  it('names the line by id and lets the box supply the text', () => {
    expect(lineTextAction({ id: 'a:L2', text: 'She turns.' })).toEqual({
      ok      : true,
      id      : 'story.setLineText',
      props   : { line: 'a:L2' },
      label   : 'She turns.',
      tooltip : 'Click to retype this line',
      on      : 'a:L2',
      supplies: ['text'],
    });
    expect(keyOf(lineTextAction({ id: 'a:L2', text: '' }))).toBe('cmd:story.setLineText#a:L2');
  });
});

describe('pendingAction', () => {
  it('records the first step of each act, with its own label and sentence', () => {
    const split: Pending = { act: 'split', at: 'a:L3', into: 'a_2' };
    expect(pendingAction(split, 'a')).toEqual({
      ok: true,
      ...checkOf(split, 'a'),
      label  : 'Split',
      tooltip: 'Cut the scene here and write the tail as its own file',
    });
    expect(pendingAction({ act: 'merge', absorbed: 'b' }, 'a')).toMatchObject({
      id     : 'story.mergeScene',
      label  : 'Merge',
      tooltip: 'Fold that scene into this one and delete the file it came from',
    });
    expect(
      pendingAction({ act: 'scene', scene: 'b', heading: 'INT. HALL - DAY' }, 'a'),
    ).toMatchObject({
      id     : 'story.newScene',
      label  : 'Write it',
      tooltip: 'Write the new scene and point this one at it',
    });
  });
});

describe('controls', () => {
  const shown = {
    sceneId: 'a',
    heading: 'INT. HALL - DAY',
    lines: [
      { id: 'a:L1', text: 'One.' },
      { id: 'a:L2', text: 'Two.' },
    ],
  };
  const state = (over: Partial<ScriptPageState> = {}): ScriptPageState => ({
    shown,
    editingLine: null,
    pending    : null,
    sceneId    : 'a',
    ...over,
  });

  it('is the bar alone before the scene loads', () => {
    expect(controls(state({ shown: undefined, sceneId: '' })).map(keyOf)).toEqual([
      'fx:menu.open',
      'fx:pane.view#reload',
    ]);
    expect(pickerAction('')).toMatchObject({ props: { menu: 'scenes' }, label: 'scene…' });
    expect(pickerAction('a').label).toBe('a');
    expect(reloadAction()).toMatchObject({ props: { what: 'reload' }, on: 'reload', label: '⟳' });
  });

  it('draws a scene as its heading, then per line a handle, a cue slot and its text', () => {
    expect(controls(state()).map(keyOf)).toEqual([
      'fx:menu.open',
      'fx:pane.view#reload',
      'cmd:story.setHeading',
      'fx:drag.start#line/a:L1',
      'cmd:story.setSpeaker#a:L1',
      'cmd:story.setLineText#a:L1',
      'fx:drag.start#line/a:L2',
      'cmd:story.setSpeaker#a:L2',
      'cmd:story.setLineText#a:L2',
      'fx:popup.open#split/a:L2',
      'fx:popup.open#compose/a:L2',
    ]);
    expect(lidAction({ id: 'a:L2' }, 2)).toMatchObject({
      props  : { interaction: 'script.moveLine' },
      label  : '2',
      tooltip: 'Line 2 of this scene, a:L2 — drag this handle to move it',
    });
  });

  it('stands a box in for the line whose text is open, and keeps its cue slot', () => {
    const keys = controls(state({ editingLine: 'a:L1' })).map(keyOf);
    expect(keys).not.toContain('cmd:story.setLineText#a:L1');
    expect(keys).toContain('cmd:story.setLineText#a:L1/box');
    expect(keys).toContain('cmd:story.setSpeaker#a:L1');
    expect(lineBox({ id: 'a:L1', text: 'One.' })).toMatchObject({
      id      : 'story.setLineText',
      props   : { line: 'a:L1' },
      label   : 'Retype a:L1',
      supplies: ['text'],
    });
  });

  it('invites the first line of an empty scene, and offers the composer’s box while one is open', () => {
    const empty = { ...shown, lines: [] };
    expect(controls(state({ shown: empty })).map(keyOf)).toEqual([
      'fx:menu.open',
      'fx:pane.view#reload',
      'cmd:story.setHeading',
      'fx:popup.open#compose/first',
    ]);
    expect(startAction('a').label).toBe('a has no lines yet — write the first one.');
    expect(controls(state({ shown: empty, composing: '' })).map(keyOf)).toEqual([
      'fx:menu.open',
      'fx:pane.view#reload',
      'cmd:story.setHeading',
      'cmd:story.insertLine#compose/first',
    ]);
    expect(composeBox('a', 'a:L2')).toEqual({
      ok      : true,
      id      : 'story.insertLine',
      props   : { scene: 'a', after: 'a:L2' },
      on      : 'compose/a:L2',
      label   : 'Write the line, then Enter',
      tooltip : 'Write a new line — Enter writes it, Escape leaves the scene alone',
      supplies: ['text'],
    });
    const keys = controls(state({ composing: 'a:L2' })).map(keyOf);
    expect(keys.indexOf('cmd:story.insertLine#compose/a:L2')).toBe(
      keys.indexOf('fx:popup.open#split/a:L2') + 1,
    );
  });

  it('offers the structure acts the story allows', () => {
    const keys = controls(state({ absorb: 'b', continues: true })).map(keyOf);
    expect(keys.slice(-3)).toEqual([
      'fx:popup.open#compose/a:L2',
      'fx:popup.open#merge/b',
      'fx:popup.open#continue',
    ]);
    expect(addLineAction('a:L2')).toMatchObject({ props: { popup: 'box' }, label: '+ line' });
    expect(mergeAction('b')).toMatchObject({
      label  : 'merge b in',
      tooltip: "Take b's lines into this scene and delete its file",
    });
    expect(continueAction().label).toBe('+ scene after this one');
    expect(splitAction('a:L2')).toMatchObject({ on: 'split/a:L2', label: 'split here' });
  });

  it('lists the frames drawn from the scene after everything else', () => {
    const frames = {
      assets : [{ hash: 'a1b2c3d4', label: 'a__s1', accepted: true }],
      visible: ['script' as const],
    };
    const keys = controls(state({ frames })).map(keyOf);
    expect(keys[keys.length - 1]).toBe('item:link/asset/a1b2c3d4');
  });

  it('gives a cue slot only to a line a speaker can be given', () => {
    const lines = [
      { id: 'a:L1', text: 'CUT TO:', kind: 'transition' as const },
      { id: 'a:L2', text: 'Hello.', kind: 'dialogue' as const, speaker: 'AIKO' },
    ];
    const keys = controls(state({ shown: { ...shown, lines } })).map(keyOf);
    expect(keys).not.toContain('cmd:story.setSpeaker#a:L1');
    expect(keys).toContain('cmd:story.setSpeaker#a:L2');
  });

  it('says what picking does on the slot whose picker is open', () => {
    const cast = [{ id: 'aiko', name: 'Aiko' }];
    const closed = speakerAction({ id: 'a:L2', speaker: 'AIKO' }, cast, false);
    expect(closed).toEqual({
      ok      : true,
      id      : 'story.setSpeaker',
      props   : { line: 'a:L2' },
      on      : 'a:L2',
      label   : 'Aiko',
      tooltip : 'Aiko says this line — click to change who does',
      supplies: ['speaker'],
    });
    expect(speakerAction({ id: 'a:L2', speaker: 'AIKO' }, cast, true).tooltip).toBe(
      'Who says this line — picking nobody makes it narration',
    );
    expect(speakerAction({ id: 'a:L1' }, cast, false)).toMatchObject({
      label  : 'narrator',
      tooltip: 'Nobody says this line — click to give it a speaker',
    });
  });

  it('adds the strip’s fields, button and Cancel only over a scene, and withholds the splits', () => {
    const pending: Pending = { act: 'merge', absorbed: 'b' };
    const keys = controls(state({ pending })).map(keyOf);
    expect(keys.slice(-2)).toEqual(['cmd:story.mergeScene', 'fx:popup.close#cancel']);
    expect(keys).not.toContain('fx:popup.open#split/a:L2');
    expect(controls(state({ pending, sceneId: '' })).map(keyOf)).not.toContain(
      'cmd:story.mergeScene',
    );
    const scene: Pending = { act: 'scene', scene: 'a_2', heading: 'INT. HALL - DAY' };
    expect(
      controls(state({ pending: scene }))
        .map(keyOf)
        .slice(-4),
    ).toEqual([
      'cmd:story.newScene#scene',
      'cmd:story.newScene#heading',
      'cmd:story.newScene',
      'fx:popup.close#cancel',
    ]);
    expect(pendingFields({ act: 'split', at: 'a:L2', into: 'a_2' })).toEqual(['into']);
    expect(pendingBox(scene, 'a', 'heading')).toMatchObject({
      id     : 'story.newScene',
      props  : { scene: 'a_2', heading: 'INT. HALL - DAY' },
      label  : "The new scene's heading",
      tooltip: "The new scene's heading. Enter confirms the act, Escape abandons it.",
    });
    expect(cancelAction()).toMatchObject({ props: { popup: 'box' }, label: 'Cancel' });
  });

  it('lists every control the page draws, each key once', () => {
    const pending: Pending = { act: 'split', at: 'a:L2', into: 'a_2' };
    for (const s of [
      state(),
      state({ editingLine: 'a:L2', pending }),
      state({ shown: undefined }),
    ]) {
      const listed = controls(s);
      const each = [pickerAction(s.sceneId), reloadAction()];
      if (s.shown) {
        const last = s.shown.lines[s.shown.lines.length - 1];
        each.push(
          headingAction(s.shown),
          ...s.shown.lines.flatMap((l, i) => [
            lidAction(l, i + 1),
            speakerAction(l, [], false),
            l.id === s.editingLine ? lineBox(l) : lineTextAction(l),
            ...(i > 0 && s.pending === null ? [splitAction(l.id)] : []),
          ]),
          ...(last ? [addLineAction(last.id)] : []),
        );
      }
      if (s.pending && s.sceneId) {
        const pending = s.pending;
        each.push(
          ...pendingFields(pending).map((f) => pendingBox(pending, s.sceneId, f)),
          pendingAction(pending, s.sceneId),
          cancelAction(),
        );
      }
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});
