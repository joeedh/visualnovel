import { splitScenes } from '@vn/model';
import { parseFountain } from '@vn/parse';
import type { Scene } from '@vn/types';
import {
  deleteLine,
  deleteLines,
  deleteScene,
  insertLine,
  insertLines,
  mergeScene,
  moveLine,
  newScene,
  setHeading,
  setLineText,
  setSpeaker,
  splitScene,
  type LineOp,
  type ScriptState,
} from '../lineops.js';

/**
 * The scenes come out of the real parser rather than being hand-built. Line ids are allocated on
 * read, so a fixture that stamps them by hand could hand out an id the allocator never would,
 * which is the class of bug these ops exist to avoid.
 */
const SCRIPT = `INT. CLASSROOM - EVENING

[[scene: arrival]]
[[next: rooftop]]

Aiko slips into the seat by the window.

AIKO
You're late.

EXT. ROOFTOP - SUNSET

[[scene: rooftop]]
[[choice: "Stay a while" -> ending]]

REN
I know.

>CUT TO:

.THE END

[[scene: ending]]

Curtain.

INT. ATTIC - NIGHT

[[scene: attic]]

Dust, and one chair.
`;

const state = (entry = 'arrival'): ScriptState => {
  const split = splitScenes(parseFountain(SCRIPT));
  expect(split.diagnostics).toEqual([]);
  return { scenes: new Map(split.scenes.map((s) => [s.id, s])), entry };
};

/** The scene an op wrote, by id — every assertion below is about written scenes. */
const written = (op: LineOp, id: string): Scene => {
  if (!op.ok) throw new Error(`refused: ${op.error}`);
  const scene = op.writes.find((s) => s.id === id);
  if (!scene) throw new Error(`${id} was not written (wrote ${op.writes.map((s) => s.id)})`);
  return scene;
};

const ids = (scene: Scene): string[] => scene.lines.map((l) => l.id);
const error = (op: LineOp): string => (op.ok ? 'accepted' : op.error);

describe('the fixture', () => {
  it('allocates the ids the ops are addressed by', () => {
    const s = state();
    expect(ids(s.scenes.get('arrival') as Scene)).toEqual(['arrival:L1', 'arrival:L2']);
    expect(ids(s.scenes.get('rooftop') as Scene)).toEqual(['rooftop:L1', 'rooftop:L2']);
  });
});

describe('setLineText', () => {
  it('retypes one line, leaving every other id where it was', () => {
    const op = setLineText(state(), { line: 'arrival:L1', text: 'Aiko takes the aisle seat.' });
    const scene = written(op, 'arrival');
    expect(ids(scene)).toEqual(['arrival:L1', 'arrival:L2']);
    expect(scene.lines[0]).toMatchObject({ id: 'arrival:L1', text: 'Aiko takes the aisle seat.' });
    expect(scene.lines[1]).toMatchObject({ text: "You're late." });
  });

  it('reports the retype, because the art covering that line was made from the old text', () => {
    const op = setLineText(state(), { line: 'arrival:L2', text: 'You came.' });
    expect(op).toMatchObject({ ok: true, retyped: ['arrival:L2'], retired: [], moved: [] });
  });

  it('reports nothing when the text is what it already said', () => {
    const op = setLineText(state(), { line: 'arrival:L2', text: "You're late." });
    expect(op).toMatchObject({ ok: true, retyped: [] });
  });

  it('refuses an unknown line, an unknown scene, and emptying a line', () => {
    expect(error(setLineText(state(), { line: 'arrival:L9', text: 'x' }))).toBe(
      'Scene "arrival" has no line "arrival:L9".',
    );
    expect(error(setLineText(state(), { line: 'nowhere:L1', text: 'x' }))).toBe(
      'No scene "nowhere".',
    );
    expect(error(setLineText(state(), { line: 'arrival:L1', text: '   ' }))).toMatch(
      /cannot be empty/,
    );
  });
});

describe('insertLine', () => {
  it('takes the next id from the allocator rather than the position it lands in', () => {
    const op = insertLine(state(), {
      scene: 'arrival',
      after: '',
      kind: 'narration',
      speaker: '',
      text: 'The bell has already gone.',
    });
    const scene = written(op, 'arrival');
    expect(ids(scene)).toEqual(['arrival:L3', 'arrival:L1', 'arrival:L2']);
    expect(scene.nextLineId).toBe(4);
  });

  it('inserts after a named line', () => {
    const op = insertLine(state(), {
      scene: 'arrival',
      after: 'arrival:L1',
      kind: 'dialogue',
      speaker: 'REN',
      text: 'Move up.',
    });
    const scene = written(op, 'arrival');
    expect(ids(scene)).toEqual(['arrival:L1', 'arrival:L3', 'arrival:L2']);
    expect(scene.lines[1]).toMatchObject({ kind: 'dialogue', speaker: 'REN' });
  });

  it('refuses an anchor from another scene rather than silently appending', () => {
    const op = insertLine(state(), {
      scene: 'arrival',
      after: 'rooftop:L1',
      kind: 'narration',
      speaker: '',
      text: 'x',
    });
    expect(error(op)).toBe('Line "rooftop:L1" is not in scene "arrival".');
  });

  it('refuses dialogue with nobody speaking it, and narration with a speaker', () => {
    const base = { scene: 'arrival', after: '', text: 'x' } as const;
    expect(error(insertLine(state(), { ...base, kind: 'dialogue', speaker: '' }))).toBe(
      'A dialogue line needs a speaker.',
    );
    expect(error(insertLine(state(), { ...base, kind: 'narration', speaker: 'REN' }))).toBe(
      'A narration line is not spoken by anyone.',
    );
  });
});

describe('insertLines', () => {
  it('lands the run in order, each line after the one before it', () => {
    const op = insertLines(state(), {
      scene: 'arrival',
      after: 'arrival:L1',
      lines: [
        { kind: 'dialogue', speaker: 'REN', text: 'Move up.' },
        { kind: 'narration', speaker: '', text: 'Aiko does not move.' },
        { kind: 'dialogue', speaker: 'AIKO', text: 'No.' },
      ],
    });
    const scene = written(op, 'arrival');
    expect(ids(scene)).toEqual([
      'arrival:L1',
      'arrival:L3',
      'arrival:L4',
      'arrival:L5',
      'arrival:L2',
    ]);
    expect(scene.nextLineId).toBe(6);
    expect(op.ok && op.message).toBe(
      'Inserted 3 line(s) (arrival:L3–arrival:L5) after arrival:L1.',
    );
  });

  it('writes the scene once, however many lines the run holds', () => {
    const op = insertLines(state(), {
      scene: 'arrival',
      after: '',
      lines: [
        { kind: 'narration', speaker: '', text: 'One.' },
        { kind: 'narration', speaker: '', text: 'Two.' },
      ],
    });
    expect(op.ok && op.writes.length).toBe(1);
    expect(op.ok && op.message).toContain('at the top of arrival');
  });

  it('writes nothing at all when a line anywhere in the run is refused', () => {
    const op = insertLines(state(), {
      scene: 'arrival',
      after: '',
      lines: [
        { kind: 'narration', speaker: '', text: 'Fine.' },
        { kind: 'dialogue', speaker: '', text: 'Who says this?' },
      ],
    });
    expect(error(op)).toBe('line 2 of 2: A dialogue line needs a speaker. Nothing was inserted.');
    expect(op.ok).toBe(false);
  });

  it('refuses an empty run rather than reporting a successful no-op', () => {
    expect(error(insertLines(state(), { scene: 'arrival', after: '', lines: [] }))).toBe(
      'Nothing to insert.',
    );
  });
});

describe('deleteLine', () => {
  it('retires the id, and never hands it out again', () => {
    const op = deleteLine(state(), { line: 'arrival:L1' });
    const scene = written(op, 'arrival');
    expect(ids(scene)).toEqual(['arrival:L2']);
    expect(scene.nextLineId).toBe(3);
    expect(op).toMatchObject({ ok: true, retired: ['arrival:L1'] });
  });

  it('leaves an empty scene rather than removing the chunk', () => {
    let s = state();
    for (const line of ['attic:L1']) {
      const op = deleteLine(s, { line });
      s = { ...s, scenes: new Map(s.scenes).set('attic', written(op, 'attic')) };
    }
    expect(ids(s.scenes.get('attic') as Scene)).toEqual([]);
  });
});

describe('deleteLines', () => {
  it('clears a run in one act, writing the scene once', () => {
    const op = deleteLines(state(), { lines: ['arrival:L1', 'arrival:L2'] });
    expect(ids(written(op, 'arrival'))).toEqual([]);
    expect(op).toMatchObject({ ok: true, retired: ['arrival:L1', 'arrival:L2'] });
    expect(op.ok && op.writes.length).toBe(1);
    expect(op.ok && op.message).toBe('Deleted 2 line(s); 0 line(s) left in arrival.');
  });

  it('takes the ids in any order, and across scenes', () => {
    const op = deleteLines(state(), { lines: ['rooftop:L2', 'arrival:L1'] });
    expect(ids(written(op, 'arrival'))).toEqual(['arrival:L2']);
    expect(ids(written(op, 'rooftop'))).toEqual(['rooftop:L1']);
    expect(op.ok && op.writes.length).toBe(2);
  });

  it('deletes nothing at all when an id anywhere in the run is refused', () => {
    const op = deleteLines(state(), { lines: ['arrival:L1', 'arrival:L9'] });
    expect(error(op)).toBe(
      'line 2 of 2: Scene "arrival" has no line "arrival:L9". Nothing was deleted.',
    );
  });

  it('refuses the same id twice rather than reporting a deletion that did not happen', () => {
    expect(error(deleteLines(state(), { lines: ['arrival:L1', 'arrival:L1'] }))).toContain(
      'Nothing was deleted.',
    );
  });

  it('refuses an empty run rather than reporting a successful no-op', () => {
    expect(error(deleteLines(state(), { lines: [] }))).toBe('Nothing to delete.');
  });
});

describe('moveLine', () => {
  it('reorders without changing an id, and reports the reorder', () => {
    const op = moveLine(state(), { line: 'arrival:L2', after: '' });
    expect(ids(written(op, 'arrival'))).toEqual(['arrival:L2', 'arrival:L1']);
    expect(op).toMatchObject({ ok: true, retired: [], retyped: ['arrival:L2'] });
  });

  it('moves after a line that sits below it', () => {
    const op = moveLine(state(), { line: 'rooftop:L1', after: 'rooftop:L2' });
    expect(ids(written(op, 'rooftop'))).toEqual(['rooftop:L2', 'rooftop:L1']);
  });

  it('refuses moving a line after itself, or after a line in another scene', () => {
    expect(error(moveLine(state(), { line: 'arrival:L1', after: 'arrival:L1' }))).toBe(
      'A line cannot be moved after itself.',
    );
    expect(error(moveLine(state(), { line: 'arrival:L1', after: 'rooftop:L1' }))).toBe(
      'Line "rooftop:L1" is not in scene "arrival".',
    );
  });
});

describe('setSpeaker', () => {
  it('makes narration dialogue, and dialogue narration again', () => {
    const spoken = setSpeaker(state(), { line: 'arrival:L1', speaker: 'AIKO' });
    expect(written(spoken, 'arrival').lines[0]).toMatchObject({
      kind: 'dialogue',
      speaker: 'AIKO',
    });

    const cleared = setSpeaker(state(), { line: 'arrival:L2', speaker: '' });
    expect(written(cleared, 'arrival').lines[1]).toEqual({
      id: 'arrival:L2',
      kind: 'narration',
      text: "You're late.",
    });
  });

  it('refuses a line nobody could speak, and a clear with nothing to clear', () => {
    expect(error(setSpeaker(state(), { line: 'rooftop:L2', speaker: 'REN' }))).toBe(
      'A transition line is not spoken by anyone.',
    );
    expect(error(setSpeaker(state(), { line: 'arrival:L1', speaker: '' }))).toBe(
      'arrival:L1 has no speaker to clear.',
    );
  });
});

describe('newScene', () => {
  it('creates an empty chunk from a heading, wired to nothing', () => {
    const op = newScene(state(), { scene: 'garden', heading: 'EXT. WALLED GARDEN - DAWN' });
    expect(written(op, 'garden')).toMatchObject({
      id: 'garden',
      location: 'walled_garden',
      locationVariant: 'dawn',
      headingPrefix: 'EXT.',
      lines: [],
      nextLineId: 1,
      choices: [],
    });
    expect(written(op, 'garden').next).toBeUndefined();
  });

  it('refuses an id that exists, an id that is not a slug, and a missing heading', () => {
    expect(error(newScene(state(), { scene: 'arrival', heading: 'INT. X - DAY' }))).toBe(
      'Scene "arrival" already exists.',
    );
    expect(error(newScene(state(), { scene: 'The Roof', heading: 'INT. X - DAY' }))).toBe(
      'Scene ids are slugs — "The Roof" would be "the_roof".',
    );
    expect(error(newScene(state(), { scene: 'garden', heading: '' }))).toMatch(/needs a heading/);
  });
});

describe('setHeading', () => {
  it('moves the scene, leaving every line id and the wiring alone', () => {
    const op = setHeading(state(), { scene: 'arrival', heading: 'EXT. WALLED GARDEN - DAWN' });
    const scene = written(op, 'arrival');
    expect(scene).toMatchObject({
      location: 'walled_garden',
      locationVariant: 'dawn',
      headingPrefix: 'EXT.',
      next: 'rooftop',
    });
    expect(ids(scene)).toEqual(['arrival:L1', 'arrival:L2']);
    expect(op).toMatchObject({ retired: [], moved: [], retyped: [] });
  });

  it('restages the scene, because a shot pinned to the old variant would get no plate', () => {
    const op = setHeading(state(), { scene: 'arrival', heading: 'EXT. WALLED GARDEN - DAWN' });
    expect(op.ok && op.relocated).toEqual([['arrival', 'dawn']]);
  });

  it('drops a prefix the new heading does not have', () => {
    const op = setHeading(state(), { scene: 'arrival', heading: '.THE VOID - LATER' });
    expect(written(op, 'arrival').headingPrefix).toBeUndefined();
  });

  it('says what the art will cost and who can fix the prose', () => {
    const op = setHeading(state(), { scene: 'arrival', heading: 'EXT. WALLED GARDEN - DAWN' });
    expect(op.ok && op.message).toMatch(/was classroom \(evening\)/);
    expect(op.ok && op.message).toMatch(/ask the agent/);
  });

  it('refuses an unknown scene, an empty heading, and a heading that names nowhere', () => {
    expect(error(setHeading(state(), { scene: 'nowhere', heading: 'INT. X - DAY' }))).toBe(
      'No scene "nowhere".',
    );
    expect(error(setHeading(state(), { scene: 'arrival', heading: '' }))).toMatch(
      /needs a heading/,
    );
    expect(error(setHeading(state(), { scene: 'arrival', heading: 'INT.' }))).toMatch(
      /names no location/,
    );
  });

  it('refuses the heading it already has, rather than rehashing the scene for nothing', () => {
    expect(
      error(setHeading(state(), { scene: 'arrival', heading: 'INT. CLASSROOM - EVENING' })),
    ).toBe('arrival is already set in classroom (evening).');
  });
});

describe('deleteScene', () => {
  it('removes a chunk nothing points at, retiring its line ids', () => {
    const op = deleteScene(state(), { scene: 'attic' });
    expect(op).toMatchObject({
      ok: true,
      writes: [],
      removes: ['attic'],
      retired: ['attic:L1'],
    });
  });

  it('refuses while anything still points at it, naming every referrer', () => {
    expect(error(deleteScene(state(), { scene: 'rooftop' }))).toBe(
      'arrival (next) still point(s) at rooftop.',
    );
    expect(error(deleteScene(state(), { scene: 'ending' }))).toBe(
      'rooftop (choice 0: "Stay a while") still point(s) at ending.',
    );
  });

  it('refuses the entry scene, naming what would have to change first', () => {
    expect(error(deleteScene(state(), { scene: 'arrival' }))).toMatch(/entry scene/);
  });
});

describe('splitScene', () => {
  it('keeps each moved line’s local id, so coverage can follow it', () => {
    const op = splitScene(state(), { scene: 'rooftop', at: 'rooftop:L2', into: 'aftermath' });
    expect(ids(written(op, 'rooftop'))).toEqual(['rooftop:L1']);
    expect(ids(written(op, 'aftermath'))).toEqual(['aftermath:L2']);
    expect(op).toMatchObject({ ok: true, moved: [['rooftop:L2', 'aftermath:L2']], retired: [] });
  });

  it('gives the tail the branch out and the head a continuation to it', () => {
    const op = splitScene(state(), { scene: 'rooftop', at: 'rooftop:L2', into: 'aftermath' });
    expect(written(op, 'rooftop')).toMatchObject({ choices: [], next: 'aftermath' });
    expect(written(op, 'aftermath')).toMatchObject({
      choices: [{ label: 'Stay a while', goto: 'ending' }],
      location: 'rooftop',
      locationVariant: 'sunset',
      headingPrefix: 'EXT.',
    });
  });

  it('shares one allocator between the halves, so neither can hand out the other’s id', () => {
    const op = splitScene(state(), { scene: 'rooftop', at: 'rooftop:L2', into: 'aftermath' });
    expect(written(op, 'rooftop').nextLineId).toBe(3);
    expect(written(op, 'aftermath').nextLineId).toBe(3);
  });

  it('refuses a split at the first line, and a tail id that exists', () => {
    expect(error(splitScene(state(), { scene: 'rooftop', at: 'rooftop:L1', into: 'x' }))).toBe(
      'rooftop:L1 is the first line of rooftop; the split would leave it empty.',
    );
    expect(error(splitScene(state(), { scene: 'rooftop', at: 'rooftop:L2', into: 'attic' }))).toBe(
      'Scene "attic" already exists.',
    );
  });
});

describe('mergeScene', () => {
  it('appends the absorbed lines under the survivor’s allocator, and maps every id it renamed', () => {
    const op = mergeScene(state(), { scene: 'rooftop', into: 'arrival' });
    const merged = written(op, 'arrival');
    expect(ids(merged)).toEqual(['arrival:L1', 'arrival:L2', 'arrival:L3', 'arrival:L4']);
    expect(merged.nextLineId).toBe(5);
    // Renumbered rather than retired, so a shot's coverage can follow the merge
    expect(op).toMatchObject({
      ok: true,
      removes: ['rooftop'],
      retired: [],
      moved: [
        ['rooftop:L1', 'arrival:L3'],
        ['rooftop:L2', 'arrival:L4'],
      ],
    });
  });

  it('carries the absorbed scene’s branch out onto the survivor', () => {
    const merged = written(mergeScene(state(), { scene: 'rooftop', into: 'arrival' }), 'arrival');
    expect(merged.choices).toEqual([{ label: 'Stay a while', goto: 'ending' }]);
    expect(merged.next).toBeUndefined();
  });

  it('refuses a merge across anything but a linear continuation', () => {
    expect(error(mergeScene(state(), { scene: 'attic', into: 'arrival' }))).toBe(
      'arrival does not continue to attic; a merge only removes a boundary.',
    );
    expect(error(mergeScene(state(), { scene: 'ending', into: 'rooftop' }))).toMatch(
      /rooftop forks into 1 choice\(s\)/,
    );
    expect(error(mergeScene(state(), { scene: 'arrival', into: 'rooftop' }))).toMatch(
      /entry scene/,
    );
  });

  it('refuses while a third scene also points at the one being absorbed', () => {
    const s = state();
    const attic = s.scenes.get('attic') as Scene;
    const scenes = new Map(s.scenes).set('attic', { ...attic, next: 'rooftop' });
    expect(error(mergeScene({ ...s, scenes }, { scene: 'rooftop', into: 'arrival' }))).toBe(
      'attic (next) also point(s) at rooftop.',
    );
  });
});
