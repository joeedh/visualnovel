import { parseFountain, parseFrontMatter } from '@vn/parse';
import { buildModel, errors, isValid, toMermaid, type BuildInputs } from './index.js';

const charDoc = (id: string, name: string) =>
  parseFrontMatter(`---\nid: ${id}\nname: ${name}\n---\n\n${name} is a person.\n`);

function inputs(script: string, withChars = true): BuildInputs {
  return {
    title: 'Test',
    characterDocs: withChars ? [charDoc('aiko', 'Aiko'), charDoc('ren', 'Ren')] : [],
    locationDocs: [],
    script: parseFountain(script),
  };
}

const VALID = `INT. CLASSROOM - DAY

[[scene: start]]
[[choice: "go a" -> a]]
[[choice: "go b" -> b]]

AIKO
Hi.

INT. ROOFTOP - SUNSET

[[scene: a]]
[[next: end]]

REN
Yo.

INT. HALL - DAY

[[scene: b]]
[[next: end]]

INT. ENDING - NIGHT

[[scene: end]]

The end.
`;

describe('buildModel — valid project', () => {
  const model = buildModel(inputs(VALID));

  it('builds scenes as graph nodes with ids from branch markers', () => {
    expect([...model.scenes.keys()].sort()).toEqual(['a', 'b', 'end', 'start']);
    expect(model.entry).toBe('start');
  });

  it('records choices and linear next edges', () => {
    expect(model.scenes.get('start')!.choices.map((c) => c.goto)).toEqual(['a', 'b']);
    expect(model.scenes.get('a')!.next).toBe('end');
  });

  it('mines locations from headings with time-of-day variants', () => {
    expect(model.locations.has('classroom')).toBe(true);
    expect(model.locations.get('rooftop')!.variants.map((v) => v.id)).toContain('sunset');
    expect(model.locations.get('classroom')!.mined).toBe(true);
  });

  it('resolves character cues to ids', () => {
    expect(model.scenes.get('start')!.characters).toEqual(['aiko']);
    expect(model.scenes.get('a')!.characters).toEqual(['ren']);
  });

  it('computes reachability — everything is reachable', () => {
    expect(model.reachable).toEqual(new Set(['start', 'a', 'b', 'end']));
    expect(isValid(model)).toBe(true);
    expect(errors(model)).toHaveLength(0);
  });

  it('emits a Mermaid graph', () => {
    const mmd = toMermaid(model);
    expect(mmd).toContain('flowchart TD');
    expect(mmd).toContain('start -->|go a| a');
  });
});

const LINES_SCRIPT = `INT. CLASSROOM - AFTERNOON

[[scene: arrival]]

The door slides open. Aiko steps in.

AIKO
Um... hello. I just transferred in.

She bows, a little too deeply.

REN
Welcome.
`;

describe('splitScenes — structured lines', () => {
  const model = buildModel(inputs(LINES_SCRIPT));
  const lines = model.scenes.get('arrival')!.lines;

  it('produces ordered lines with stable scene-scoped ids', () => {
    expect(lines.map((l) => l.id)).toEqual([
      'arrival:L1',
      'arrival:L2',
      'arrival:L3',
      'arrival:L4',
    ]);
  });

  it('classifies kinds: narration, dialogue, stage-direction action', () => {
    expect(lines.map((l) => l.kind)).toEqual(['narration', 'dialogue', 'action', 'dialogue']);
  });

  it('attributes dialogue to resolved character ids and leaves narration unattributed', () => {
    expect(lines[0]!.speaker).toBeUndefined();
    expect(lines[1]!.speaker).toBe('aiko');
    // Action after a cue is a stage direction for that speaker.
    expect(lines[2]!).toMatchObject({ kind: 'action', speaker: 'aiko' });
    expect(lines[3]!.speaker).toBe('ren');
  });

  it('reflects [[scene: id]] overrides in line ids', () => {
    expect(lines.every((l) => l.id.startsWith('arrival:'))).toBe(true);
  });
});

const INVALID = `INT. CLASSROOM - DAY

[[scene: start]]
[[choice: "x" -> missing]]

INT. ROOFTOP - NIGHT

[[scene: orphan]]

Nobody comes here.
`;

describe('buildModel — validation', () => {
  const model = buildModel(inputs(INVALID, false));

  it('rejects dangling gotos as errors', () => {
    expect(isValid(model)).toBe(false);
    expect(errors(model).some((d) => d.code === 'dangling_goto')).toBe(true);
  });

  it('flags unreachable scenes as warnings', () => {
    expect(model.reachable.has('orphan')).toBe(false);
    expect(
      model.diagnostics.some((d) => d.code === 'unreachable_scene' && d.where === 'orphan'),
    ).toBe(true);
  });
});
