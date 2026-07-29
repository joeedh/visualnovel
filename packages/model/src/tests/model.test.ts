import { parseFountain, parseFrontMatter, type SceneChunkDoc } from '@vn/parse';
import { buildModel, errors, isValid, toMermaid, type BuildInputs } from '../index.js';

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

  it('classifies kinds: narration and dialogue', () => {
    expect(lines.map((l) => l.kind)).toEqual(['narration', 'dialogue', 'narration', 'dialogue']);
  });

  it('attributes dialogue to resolved character ids and leaves narration unattributed', () => {
    expect(lines[0]!.speaker).toBeUndefined();
    expect(lines[1]!.speaker).toBe('aiko');
    // A cue's speaker ends with its dialogue block: the action below it is nobody's.
    expect(lines[2]!.kind).toBe('narration');
    expect(lines[2]!.speaker).toBeUndefined();
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

const chunk = (id: string, body: string): SceneChunkDoc => ({
  id,
  file: `scenes/${id}.md`,
  doc: parseFrontMatter(`---\nscene: ${id}\n---\n\n${body}`),
});

function chunkInputs(sceneDocs: SceneChunkDoc[], start?: string, script = ''): BuildInputs {
  return {
    title: 'Test',
    characterDocs: [charDoc('aiko', 'Aiko'), charDoc('ren', 'Ren')],
    locationDocs: [],
    sceneDocs,
    script: parseFountain(script),
    start,
  };
}

const ARRIVAL_CHUNK = `INT. CLASSROOM - DAY

[[choice: "go up" -> rooftop]]

AIKO
Hi.
`;

const ROOFTOP_CHUNK = `INT. ROOFTOP - SUNSET

REN
Yo.
`;

describe('buildModel — scenes authored as chunks', () => {
  const CHUNKS = [chunk('arrival', ARRIVAL_CHUNK), chunk('rooftop', ROOFTOP_CHUNK)];
  const model = buildModel(chunkInputs(CHUNKS, 'arrival'));

  it('keys scenes by their chunk id and takes the entry from start:', () => {
    expect([...model.scenes.keys()]).toEqual(['arrival', 'rooftop']);
    expect(model.entry).toBe('arrival');
    expect(model.scenes.get('arrival')!.lines[0]!.id).toBe('arrival:L1');
  });

  it('mines locations, resolves cast, and validates edges as the screenplay form does', () => {
    expect(model.scenes.get('arrival')!.choices.map((c) => c.goto)).toEqual(['rooftop']);
    expect(model.locations.get('rooftop')!.variants.map((v) => v.id)).toEqual(['sunset']);
    expect(model.scenes.get('rooftop')!.characters).toEqual(['ren']);
    expect(model.reachable).toEqual(new Set(['arrival', 'rooftop']));
    expect(errors(model)).toHaveLength(0);
  });

  it('ignores the screenplay when chunks are present — the forms never mix', () => {
    const both = buildModel(chunkInputs(CHUNKS, 'arrival', VALID));
    expect([...both.scenes.keys()]).toEqual(['arrival', 'rooftop']);
  });

  it('errors when a chunk project has no start:, rather than guessing one', () => {
    const m = buildModel(chunkInputs(CHUNKS));
    expect(m.entry).toBeUndefined();
    expect(errors(m).map((d) => d.code)).toContain('missing_start');
  });

  it('errors when start: names a scene no chunk provides', () => {
    const m = buildModel(chunkInputs(CHUNKS, 'nowhere'));
    expect(m.entry).toBeUndefined();
    const err = errors(m).find((d) => d.code === 'unknown_start');
    expect(err!.message).toContain('"nowhere"');
  });

  it('reports a bad chunk without losing the good ones', () => {
    const m = buildModel(
      chunkInputs([CHUNKS[0]!, chunk('rooftop', 'No heading here.\n')], 'arrival'),
    );
    expect([...m.scenes.keys()]).toEqual(['arrival']);
    expect(errors(m).map((d) => d.code)).toContain('scene_body');
  });

  it("carries the loader's own diagnostics through to the model", () => {
    const m = buildModel({
      ...chunkInputs(CHUNKS, 'arrival'),
      diagnostics: [{ severity: 'error', code: 'two_input_formats', message: 'both forms' }],
    });
    expect(errors(m).map((d) => d.code)).toContain('two_input_formats');
  });
});
