import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFountain } from '@vn/parse';
import { assignLineIds } from '../lineids.js';
import { splitScenes } from '../scenes.js';

const split = (text: string) => splitScenes(parseFountain(text));
const localIds = (text: string) =>
  split(text).scenes[0]!.lines.map((l) => l.id.replace(/^[^:]*:/, ''));

const UNMARKED = `INT. CLASSROOM - AFTERNOON

[[scene: arrival]]

The door slides open.

AIKO
Um... hello.

She bows, a little too deeply.

REN
Welcome.
`;

const MARKED = `INT. CLASSROOM - AFTERNOON

[[scene: arrival]]
[[nextline: 12]]

[[line: L1]]
The door slides open.

AIKO
[[line: L4]]
Um... hello.

[[line: L7]]
She bows, a little too deeply.
`;

describe('splitScenes — line id allocation', () => {
  it('allocates L1..Ln in document order when nothing is marked', () => {
    // The backward-compatibility property: an unmigrated screenplay keeps the ids the old
    // positional stamp gave it, so existing coverage in work/shots survives the upgrade.
    expect(localIds(UNMARKED)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(split(UNMARKED).scenes[0]!.nextLineId).toBe(5);
    expect(split(UNMARKED).diagnostics).toEqual([]);
  });

  it('honours a mark on action, on dialogue after a cue, and the allocator', () => {
    const { scenes, diagnostics } = split(MARKED);
    expect(localIds(MARKED)).toEqual(['L1', 'L4', 'L7']);
    expect(scenes[0]!.lines.map((l) => l.kind)).toEqual(['narration', 'dialogue', 'action']);
    expect(scenes[0]!.nextLineId).toBe(12);
    expect(diagnostics).toEqual([]);
  });

  it('composes marked local ids with the [[scene:]] override', () => {
    expect(split(MARKED).scenes[0]!.lines.map((l) => l.id)).toEqual([
      'arrival:L1',
      'arrival:L4',
      'arrival:L7',
    ]);
  });

  it('allocates unmarked lines from the mark, never onto a marked id', () => {
    const mixed = `INT. CLASSROOM - DAY

[[scene: arrival]]

[[line: L9]]
Rain ticks off the gate.

An unmarked beat.

Another unmarked beat.
`;
    expect(localIds(mixed)).toEqual(['L9', 'L10', 'L11']);
    expect(split(mixed).scenes[0]!.nextLineId).toBe(12);
  });

  it('raises a stale [[nextline:]] above every id in use', () => {
    const stale = `INT. CLASSROOM - DAY

[[scene: arrival]]
[[nextline: 3]]

[[line: L7]]
Rain ticks off the gate.

An unmarked beat.
`;
    expect(localIds(stale)).toEqual(['L7', 'L8']);
    expect(split(stale).diagnostics).toEqual([]);
  });

  it('allocates per scene, so ids do not run on across headings', () => {
    const two = `INT. CLASSROOM - DAY

[[scene: a]]

One beat.

INT. ROOFTOP - NIGHT

[[scene: b]]

Another beat.
`;
    const { scenes } = split(two);
    expect(scenes.map((s) => s.lines.map((l) => l.id))).toEqual([['a:L1'], ['b:L1']]);
  });
});

describe('assignLineIds — the writer', () => {
  const sceneOf = (text: string) => splitScenes(parseFountain(text)).scenes;

  it('marks each element in place and leaves every other byte alone', () => {
    const { text, assigned, diagnostics } = assignLineIds(UNMARKED);
    expect(diagnostics).toEqual([]);
    expect(assigned).toBe(4);
    expect(text).toBe(`INT. CLASSROOM - AFTERNOON

[[scene: arrival]]
[[nextline: 5]]

[[line: L1]]
The door slides open.

AIKO
[[line: L2]]
Um... hello.

[[line: L3]]
She bows, a little too deeply.

REN
[[line: L4]]
Welcome.
`);
  });

  it('writes down exactly the ids reading already allocated', () => {
    const marked = assignLineIds(UNMARKED).text;
    expect(sceneOf(marked)[0]!.lines.map((l) => l.id)).toEqual(
      sceneOf(UNMARKED)[0]!.lines.map((l) => l.id),
    );
  });

  it('is idempotent — a second pass writes nothing', () => {
    const once = assignLineIds(UNMARKED);
    const twice = assignLineIds(once.text);
    expect(twice.assigned).toBe(0);
    expect(twice.text).toBe(once.text);
    expect(twice.diagnostics).toEqual([]);
  });

  it('adds only the missing marks to a partly-marked file', () => {
    const { text, assigned } = assignLineIds(MARKED);
    expect(assigned).toBe(0);
    // The allocator is already there and already right, so nothing moves at all.
    expect(text).toBe(MARKED);
  });

  it('updates a stale [[nextline:]] in place rather than adding a second one', () => {
    const stale = `INT. CLASSROOM - DAY

[[scene: arrival]]
[[nextline: 2]]

Rain ticks off the gate.

Another beat.
`;
    const { text } = assignLineIds(stale);
    expect(text.match(/nextline/g)).toHaveLength(1);
    expect(text).toContain('[[nextline: 4]]');
    expect(sceneOf(text)[0]!.lines.map((l) => l.id)).toEqual(['arrival:L2', 'arrival:L3']);
  });

  it('scopes to one scene when asked', () => {
    const two = `INT. CLASSROOM - DAY

[[scene: a]]

One beat.

INT. ROOFTOP - NIGHT

[[scene: b]]

Another beat.
`;
    const { text, assigned } = assignLineIds(two, 'b');
    expect(assigned).toBe(1);
    expect(text).toContain('[[line: L1]]\nAnother beat.');
    expect(text).toContain('[[scene: a]]\n\nOne beat.');
  });

  it('does not un-speak a cue or un-make a transition', () => {
    // A mark lands below the blank line a cue or an unforced transition needs above it, and
    // above the text of the element it names — inside the dialogue block, after the cue.
    const risky = `INT. CLASSROOM - DAY

[[scene: arrival]]

Rain.

CUT TO:

AIKO
(quietly)
Hi.
`;
    const { text, diagnostics } = assignLineIds(risky);
    expect(diagnostics).toEqual([]);
    const elements = parseFountain(text).elements.map((e) => e.type);
    expect(elements).toContain('transition');
    expect(elements).toContain('character');
    expect(sceneOf(text)[0]!.lines).toEqual(sceneOf(risky)[0]!.lines);
  });

  it('refuses a scene it does not have', () => {
    const { diagnostics, text } = assignLineIds(UNMARKED, 'nope');
    expect(diagnostics.map((d) => d.code)).toEqual(['line_ids_scene']);
    expect(text).toBe(UNMARKED);
  });

  it('refuses to write over an aliased mark', () => {
    const aliased = `INT. CLASSROOM - DAY

[[scene: arrival]]

[[line: L4]]
Rain ticks off the gate.

[[line: L4]]
She bows.
`;
    const { diagnostics, text } = assignLineIds(aliased);
    expect(diagnostics.map((d) => d.code)).toEqual(['duplicate_line_id']);
    expect(text).toBe(aliased);
  });

  it('leaves the sample screenplay meaning exactly what it did', () => {
    const source = readFileSync(
      join(__dirname, '../../../../examples/sample/screenplay/script.fountain'),
      'utf8',
    );
    const { text, diagnostics } = assignLineIds(source);
    expect(diagnostics).toEqual([]);
    expect(text).not.toBe(source);
    const before = splitScenes(parseFountain(source));
    const after = splitScenes(parseFountain(text));
    expect(after.scenes).toEqual(before.scenes);
    expect(assignLineIds(text).text).toBe(text);
  });
});

describe('splitScenes — line id diagnostics', () => {
  it('reports two lines marked with the same id', () => {
    const aliased = `INT. CLASSROOM - DAY

[[scene: arrival]]

[[line: L4]]
Rain ticks off the gate.

[[line: L4]]
She bows.
`;
    const { scenes, diagnostics } = split(aliased);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'duplicate_line_id',
        message:
          'scene "arrival" marks 2 lines with line id "L4"; a shot covering it cannot say which',
        where: 'arrival',
      },
    ]);
    // The ids are still produced — the diagnostic is the report, not a refusal to parse.
    expect(scenes[0]!.lines.map((l) => l.id)).toEqual(['arrival:L4', 'arrival:L4']);
  });

  it('reports a mark with no line-bearing element after it', () => {
    const dangling = `INT. CLASSROOM - DAY

[[scene: arrival]]

Rain ticks off the gate.

[[line: L9]]

INT. ROOFTOP - NIGHT

[[scene: rooftop]]

Wind.
`;
    const { scenes, diagnostics } = split(dangling);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'dangling_line_id',
        message: '[[line: L9]] in scene "arrival" names no line',
        where: 'arrival',
      },
    ]);
    // It does not leak into the next scene.
    expect(scenes[1]!.lines.map((l) => l.id)).toEqual(['rooftop:L1']);
  });

  it('reports the second of two marks with nothing between them', () => {
    const doubled = `INT. CLASSROOM - DAY

[[scene: arrival]]

[[line: L4]]
[[line: L5]]
Rain ticks off the gate.
`;
    const { scenes, diagnostics } = split(doubled);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'dangling_line_id',
        message: '[[line: L5]] in scene "arrival" names no line',
        where: 'arrival',
      },
    ]);
    expect(scenes[0]!.lines.map((l) => l.id)).toEqual(['arrival:L4']);
  });
});
