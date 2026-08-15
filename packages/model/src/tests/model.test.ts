import { parseFountain, parseFrontMatter, type EntityDoc, type SceneChunkDoc } from '@vn/parse';
import { buildModel, errors, isValid, toMermaid, type BuildInputs } from '../index.js';

/** A discovered character sheet, as `loadInputs` would hand one over. */
const charDoc = (id: string, name: string, declaredId = id): EntityDoc => {
  const text = `---\nid: ${declaredId}\nname: ${name}\n---\n\n${name} is a person.\n`;
  return { id, file: `/p/characters/${id}/character.md`, doc: parseFrontMatter(text), text };
};

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

// Before discovery carried the file, `id:` was the only id there was, so `characters/ada/` holding
// `id: ren` silently produced a character named by neither — and every path built from that id
// pointed at a sheet that was not the one loaded.
describe('buildModel — an entity id must agree with the file that holds it', () => {
  const build = (docs: EntityDoc[]) =>
    buildModel({ title: 'Test', characterDocs: docs, locationDocs: [], script: parseFountain('') });

  it('rejects a sheet whose declared id is not the one its file names', () => {
    const model = build([charDoc('ada', 'Ada', 'ren')]);
    expect([...model.characters.keys()]).toEqual([]);
    const mismatch = errors(model).filter((d) => d.code === 'entity_id_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.where).toBe('ada');
    expect(mismatch[0]!.message).toContain('/p/characters/ada/character.md');
    expect(mismatch[0]!.message).toContain('ren');
  });

  it('keeps the sheets that do agree', () => {
    const model = build([charDoc('ada', 'Ada', 'ren'), charDoc('aiko', 'Aiko')]);
    expect([...model.characters.keys()]).toEqual(['aiko']);
  });

  it('says nothing when a location agrees', () => {
    const doc: EntityDoc = {
      id: 'pier',
      file: '/p/wiki/sets/pier.md',
      doc: parseFrontMatter('---\nid: pier\ntype: location\nname: Pier\n---\n\nA pier.\n'),
      text: '',
    };
    const model = buildModel({
      title: 'Test',
      characterDocs: [],
      locationDocs: [doc],
      script: parseFountain(''),
    });
    expect([...model.locations.keys()]).toEqual(['pier']);
    expect(model.diagnostics.some((d) => d.code === 'entity_id_mismatch')).toBe(false);
  });
});

describe('buildModel — the wardrobe', () => {
  const sheet = (frontMatter: string): EntityDoc => ({
    id: 'ada',
    file: '/p/characters/ada/character.md',
    doc: parseFrontMatter(`---\nid: ada\nname: Ada\n${frontMatter}---\n\nAda.\n`),
    text: '',
  });
  const build = (fm: string) =>
    buildModel({
      title: 'Test',
      characterDocs: [sheet(fm)],
      locationDocs: [],
      script: parseFountain(''),
    });

  it('warns when the default outfit is the one the wardrobe does not describe', () => {
    const model = build('default_outfit: uniform\noutfits:\n  track: club tracksuit\n');
    const d = model.diagnostics.filter((x) => x.code === 'undescribed_default_outfit');
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe('warning');
    expect(d[0]!.message).toContain('"track"');
    // A warning, not an error: the outfit is still synthesized, so nothing is left unresolvable.
    expect(model.characters.get('ada')!.outfits.map((o) => o.id)).toEqual(['uniform', 'track']);
  });

  it('says nothing about a sheet with no wardrobe, or one that describes its default', () => {
    expect(build('').diagnostics).toEqual([]);
    expect(
      build('default_outfit: uniform\noutfits:\n  uniform: grey blazer\n  track: tracksuit\n')
        .diagnostics,
    ).toEqual([]);
  });

  it('names the paths a retired reference_images left behind, and only when there are some', () => {
    const model = build('reference_images:\n  - refs/ada-coat.png\n');
    const d = model.diagnostics.filter((x) => x.code === 'retired_reference_images');
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe('warning');
    expect(d[0]!.message).toContain('refs/ada-coat.png');
    expect(d[0]!.message).toContain('asset.upload');
    // Every sheet the fixtures ever wrote carries an empty list; that is not a migration.
    expect(build('reference_images: []\n').diagnostics).toEqual([]);
  });
});

const chunk = (id: string, body: string): SceneChunkDoc => {
  const text = `---\nscene: ${id}\n---\n\n${body}`;
  return { id, file: `scenes/${id}.md`, doc: parseFrontMatter(text), text };
};

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

describe('buildModel — the scene outfit marker', () => {
  const dressed: EntityDoc = {
    id: 'aiko',
    file: '/p/characters/aiko/character.md',
    doc: parseFrontMatter(
      '---\nid: aiko\nname: Aiko\ndefault_outfit: uniform\noutfits:\n  uniform: grey blazer\n  track: club tracksuit\n---\n\nAiko.\n',
    ),
    text: '',
  };
  const build = (markers: string) =>
    buildModel({
      ...chunkInputs([chunk('arrival', `INT. CLASSROOM - DAY\n\n${markers}\nAIKO\nHi.\n`)]),
      characterDocs: [dressed],
      start: 'arrival',
    });

  it('keeps a marker naming an outfit the character has', () => {
    const m = build('[[outfit: aiko=track]]\n');
    expect(m.scenes.get('arrival')!.outfits).toEqual({ aiko: 'track' });
    expect(m.diagnostics).toEqual([]);
  });

  // Ignored rather than honoured: the shot falls back to the default and renders, where obeying
  // would put a word in the prompt that nothing describes.
  it('warns about an outfit the character never authored, listing the ones they have', () => {
    const m = build('[[outfit: aiko=swim]]\n');
    expect(m.scenes.get('arrival')!.outfits).toBeUndefined();
    const d = m.diagnostics.filter((x) => x.code === 'unknown_outfit');
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe('warning');
    expect(d[0]!.message).toContain('"uniform", "track"');
  });

  it('warns about a marker that names no character, and keeps the rest', () => {
    const m = build('[[outfit: nobody=track]]\n[[outfit: aiko=uniform]]\n');
    expect(m.scenes.get('arrival')!.outfits).toEqual({ aiko: 'uniform' });
    expect(m.diagnostics.map((x) => x.code)).toEqual(['unknown_outfit_character']);
  });
});

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
      diagnostics: [
        { severity: 'error', code: 'legacy_screenplay', message: 'run `vngen import`' },
      ],
    });
    expect(errors(m).map((d) => d.code)).toContain('legacy_screenplay');
  });
});
