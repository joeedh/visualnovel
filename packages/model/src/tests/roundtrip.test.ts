/**
 * The round-trip property for scenes: `parse(write(scene)) ≡ scene`, in both forms a scene is
 * written in — a block of a single screenplay, and a `scenes/<id>.md` chunk.
 *
 * The sibling of `fromDoc(toDoc(x)) ≡ x` for characters and locations, and what makes
 * `sceneToFountain` safe to write with. Comparison is structural — every field the model
 * carries except `shots`, which is never serialized.
 */
import { parseFountain, parseFrontMatter } from '@vn/parse';
import type { HeadingPrefix, Scene, SceneLine } from '@vn/types';
import { SCRIPTS } from '@vn/testkit';
import { sceneFromDoc } from '../entities.js';
import { splitScenes } from '../scenes.js';
import { docToMarkdown, sceneToDoc, sceneToFountain } from '../serialize.js';

/** The scene reduced to what a round-trip has to preserve. */
function projected(scene: Scene): unknown {
  return {
    id: scene.id,
    location: scene.location,
    locationVariant: scene.locationVariant,
    headingPrefix: scene.headingPrefix,
    characters: scene.characters,
    synopsis: scene.synopsis,
    nextLineId: scene.nextLineId,
    lines: scene.lines,
    choices: scene.choices,
    next: scene.next,
  };
}

/** Write the scene, read it back, and hand over the single scene that came out. */
function reparse(scene: Scene): Scene {
  const { scenes, diagnostics } = splitScenes(parseFountain(sceneToFountain(scene)));
  expect(diagnostics).toEqual([]);
  expect(scenes).toHaveLength(1);
  return scenes[0] as Scene;
}

/**
 * The same, as a chunk — through the file *text*, so the front-matter fence is part of the
 * round trip rather than only the doc it parses to.
 */
function rechunk(scene: Scene): Scene {
  const result = sceneFromDoc(parseFrontMatter(docToMarkdown(sceneToDoc(scene))), scene.id);
  if (!result.ok) throw new Error(result.diagnostic.message);
  expect(result.value.diagnostics).toEqual([]);
  return result.value.scene;
}

const survives = (scene: Scene): void => {
  expect(projected(reparse(scene))).toEqual(projected(scene));
  expect(projected(rechunk(scene))).toEqual(projected(scene));
};

describe('sceneToFountain — round trip over the fixture scripts', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(`preserves every scene of '${name}'`, () => {
      const { scenes, diagnostics } = splitScenes(parseFountain(script));
      expect(diagnostics).toEqual([]);
      expect(scenes.length).toBeGreaterThan(0);
      for (const scene of scenes) survives(scene);
    });
  }
});

/** Build a scene the way `splitScenes` would have, so the comparison is like-for-like. */
function sceneOf(id: string, lines: Omit<SceneLine, 'id'>[], extra: Partial<Scene> = {}): Scene {
  const speakers: string[] = [];
  for (const line of lines) {
    if (line.speaker && !speakers.includes(line.speaker)) speakers.push(line.speaker);
  }
  return {
    id,
    location: 'classroom',
    locationVariant: 'day',
    headingPrefix: 'INT.',
    characters: speakers,
    lines: lines.map((line, i) => ({ ...line, id: `${id}:L${i + 1}` })),
    nextLineId: lines.length + 1,
    choices: [],
    next: undefined,
    shots: [],
    ...extra,
  };
}

describe('sceneToFountain — round trip over each line kind', () => {
  it('narration', () => {
    survives(sceneOf('s', [{ kind: 'narration', text: 'The room is quiet.' }]));
  });

  it('dialogue and parentheticals under one cue', () => {
    survives(
      sceneOf('s', [
        { kind: 'dialogue', speaker: 'AIKO', text: 'Um... hello.' },
        { kind: 'parenthetical', speaker: 'AIKO', text: 'softly' },
        { kind: 'dialogue', speaker: 'AIKO', text: 'I just transferred in.' },
      ]),
    );
  });

  it('transitions, lyrics and centered text', () => {
    survives(
      sceneOf('s', [
        { kind: 'transition', text: 'CUT TO:' },
        { kind: 'lyric', text: 'and the city hums below' },
        { kind: 'centered', text: 'THE END' },
      ]),
    );
  });

  it('a narration line that reads like every other element', () => {
    survives(
      sceneOf('s', [
        // Each of these is what a different branch of `needsForcedAction` exists for.
        { kind: 'narration', text: 'THE ROOM IS EMPTY.' },
        { kind: 'narration', text: 'INT. NOT A HEADING - DAY' },
        { kind: 'narration', text: '.forced' },
        { kind: 'narration', text: '= not a synopsis' },
        { kind: 'narration', text: '~ not a lyric' },
        { kind: 'narration', text: '> not a transition' },
        { kind: 'narration', text: '# not a section' },
        { kind: 'narration', text: '!not forced action' },
        { kind: 'narration', text: 'SMASH CUT TO:' },
      ]),
    );
  });
});

describe('sceneToFountain — round trip over scene shape', () => {
  it('a scene opening on a cue', () => {
    survives(
      sceneOf('s', [
        { kind: 'dialogue', speaker: 'REN', text: 'You came.' },
        { kind: 'narration', text: 'She bows.' },
      ]),
    );
  });

  it('adjacent blocks by the same speaker collapse to one cue and come back the same', () => {
    survives(
      sceneOf('s', [
        { kind: 'dialogue', speaker: 'AIKO', text: 'Sorry.' },
        { kind: 'dialogue', speaker: 'HARUKI', text: "Most people don't come up here." },
        { kind: 'dialogue', speaker: 'AIKO', text: 'I noticed.' },
      ]),
    );
  });

  it('a mixed-case speaker, which is not a cue by the auto-detection rules', () => {
    survives(sceneOf('s', [{ kind: 'dialogue', speaker: 'Aiko', text: 'Hello.' }]));
  });

  it('a scene with no lines at all', () => {
    survives(sceneOf('empty', []));
  });

  it('choices, a linear next, and a synopsis', () => {
    survives(
      sceneOf('rooftop', [{ kind: 'narration', text: 'The city hums somewhere below.' }], {
        synopsis: 'Ren hesitates at the door.',
        choices: [
          { label: 'Stay', goto: 'good_end' },
          { label: 'Leave', goto: 'bad_end' },
        ],
      }),
    );
    survives(sceneOf('hall', [], { next: 'rooftop' }));
  });

  it('an allocator raised past the ids in use', () => {
    survives(sceneOf('s', [{ kind: 'narration', text: 'One line.' }], { nextLineId: 12 }));
  });
});

describe('sceneFromDoc — what a chunk is allowed to be', () => {
  const chunk = (data: Record<string, unknown>, body: string): ReturnType<typeof sceneFromDoc> =>
    sceneFromDoc({ data, body }, 'arrival');
  const HEADING = 'EXT. SCHOOL GATE - AFTERNOON\n\n[[nextline: 1]]\n';

  it('writes the id to front-matter and never to the body as well', () => {
    const doc = sceneToDoc(sceneOf('arrival', [{ kind: 'narration', text: 'Rain.' }]));
    expect(doc.data).toEqual({ scene: 'arrival' });
    expect(doc.body).not.toContain('[[scene:');
  });

  it('rejects a front-matter key the body owns', () => {
    for (const key of ['next', 'location', 'heading', 'synopsis']) {
      const result = chunk({ scene: 'arrival', [key]: 'rooftop' }, HEADING);
      expect(result.ok ? 'accepted' : result.diagnostic.code).toBe('scene_frontmatter');
    }
  });

  it('rejects a filename and a scene: key that disagree, naming both', () => {
    const result = chunk({ scene: 'rooftop' }, HEADING);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe('scene_id');
    expect(result.diagnostic.message).toContain('rooftop');
    expect(result.diagnostic.message).toContain('arrival');
  });

  it('rejects a body with no heading, and one with more than one', () => {
    const none = chunk({ scene: 'arrival' }, 'Just some prose.\n');
    expect(none.ok ? 'accepted' : none.diagnostic.code).toBe('scene_body');
    const two = chunk({ scene: 'arrival' }, `${HEADING}\nINT. ROOFTOP - NIGHT\n\nMore.\n`);
    expect(two.ok ? 'accepted' : two.diagnostic.code).toBe('scene_body');
  });

  it('takes its id from the filename and warns about a [[scene:]] marker that disagrees', () => {
    const result = chunk({ scene: 'arrival' }, `${HEADING}\n[[scene: rooftop]]\n\nRain.\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scene.id).toBe('arrival');
    expect(result.value.scene.lines[0]?.id).toBe('arrival:L1');
    expect(result.value.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'ignored_scene_marker',
        message: '[[scene: rooftop]] in scene "arrival" is ignored; a chunk\'s id is its filename',
        where: 'arrival',
      },
    ]);
  });

  it('mines the location from the heading, as the screenplay form does', () => {
    const result = chunk({ scene: 'arrival' }, HEADING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mined).toEqual([
      { id: 'school_gate', name: 'SCHOOL GATE', variant: 'afternoon' },
    ]);
  });
});

describe('sceneToFountain — round trip over headings', () => {
  const PREFIXES: HeadingPrefix[] = ['INT.', 'EXT.', 'INT./EXT.', 'EST.', 'I/E'];

  for (const headingPrefix of PREFIXES) {
    it(`keeps the '${headingPrefix}' prefix`, () => {
      survives(sceneOf('s', [], { headingPrefix }));
    });
  }

  it('keeps a forced heading forced — without the leading dot the scene stops existing', () => {
    survives(sceneOf('s', [], { headingPrefix: undefined }));
  });

  it('keeps a multi-word location and its time-of-day variant', () => {
    survives(sceneOf('s', [], { location: 'rooftop_stairs', locationVariant: 'late_afternoon' }));
  });
});
