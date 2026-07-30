import { TOP, scriptMoveLine } from '../../../../../src/shared/interactions.js';
import {
  COMPOSED,
  attributionAfter,
  dropTarget,
  insertOf,
  insertedAfter,
  keyAct,
  localLineId,
  mergeTarget,
  moveStateOf,
  proposeSceneId,
  splitBoundaries,
  type Draft,
} from '../script.js';
import type {
  CoverageLine,
  SceneCoverage,
  StoryEdge,
  StoryGraph,
} from '../../../../../src/shared/ipc';

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
    lines,
    shots: [],
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

describe('splitBoundaries', () => {
  it('offers every line but the first, which would leave the head empty', () => {
    expect(splitBoundaries(lines)).toEqual(['a:L2', 'a:L3', 'a:L4']);
    expect(splitBoundaries(lines.slice(0, 1))).toEqual([]);
    expect(splitBoundaries([])).toEqual([]);
  });
});

describe('proposeSceneId', () => {
  it('suffixes the scene being split', () => {
    expect(proposeSceneId('arrival', ['arrival'])).toBe('arrival-2');
  });

  it('counts past ids already taken', () => {
    expect(proposeSceneId('arrival', ['arrival', 'arrival-2', 'arrival-3'])).toBe('arrival-4');
  });

  it('counts up from an already-suffixed scene rather than nesting', () => {
    expect(proposeSceneId('arrival-2', ['arrival', 'arrival-2'])).toBe('arrival-3');
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
