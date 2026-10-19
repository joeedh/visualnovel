import { splitScenes } from '@vn/model';
import { parseFountain } from '@vn/parse';
import type { Character, ChunkRef, Location, Scene, Shot } from '@vn/types';
import {
  deleteCharacter,
  deleteLocation,
  forgetPicture,
  type EntityOp,
  type EntityWorld,
} from '../entitydelete.js';
import { dropPins } from '../pins.js';

const SCRIPT = `INT. CLASSROOM - EVENING

[[scene: arrival]]
[[outfit: aiko=uniform]]
[[next: rooftop]]

Aiko slips into the seat by the window.

AIKO (V.O.)
You're late.

REN
I know.

EXT. ROOFTOP - SUNSET

[[scene: rooftop]]

AIKO
Over here.
`;

const character = (id: string, name: string, extra: Partial<Character> = {}): Character => ({
  id,
  name,
  description  : '',
  traits       : [],
  palette      : [],
  status       : 'draft',
  defaultOutfit: 'default',
  outfits: [
    { id: 'default', characterId: id, description: '' },
    { id: 'uniform', characterId: id, description: 'the school uniform' },
  ],
  ...extra,
});

const location = (id: string, variants: string[], extra: Partial<Location> = {}): Location => ({
  id,
  name       : id.charAt(0).toUpperCase() + id.slice(1),
  description: '',
  palette    : [],
  variants   : variants.map((v) => ({ id: v, description: '' })),
  mined      : false,
  ...extra,
});

const pin = (hash: string, from?: ChunkRef['from']): ChunkRef => ({
  pin: hash,
  ext: 'png',
  ...(from ? { from } : {}),
});

const shot = (
  id: string,
  sceneId: string,
  subjects: string[],
  extra: Partial<Shot> = {},
): Shot => ({
  id,
  sceneId,
  framing    : 'medium',
  location   : sceneId === 'arrival' ? 'evening' : 'sunset',
  subjects   : subjects.map((characterId) => ({ characterId })),
  coversLines: [],
  ...extra,
});

function world(patch: Partial<EntityWorld> = {}): EntityWorld {
  const split = splitScenes(parseFountain(SCRIPT));
  expect(split.diagnostics).toEqual([]);
  return {
    state     : { scenes: new Map(split.scenes.map((s) => [s.id, s])), entry: 'arrival' },
    shots: new Map([
      [
        'arrival',
        [
          shot('arrival__a', 'arrival', ['aiko', 'ren'], {
            coversLines   : ['arrival:L2', 'arrival:L3'],
            subjects      : [{ characterId: 'aiko', outfit: 'uniform' }, { characterId: 'ren' }],
            image         : 'rendered',
            promptOverride: {
              mode: 'chunks',
              refs: {
                subject: [
                  pin('portrait1', { kind: 'portrait', characterId: 'aiko' }),
                  pin('take1'),
                  pin('kept'),
                ],
              },
            },
          }),
        ],
      ],
      [
        'rooftop',
        [
          shot('rooftop__a', 'rooftop', ['aiko'], {
            coversLines : ['rooftop:L1'],
            castOptional: true,
          }),
        ],
      ],
    ]),
    characters: new Map([
      ['aiko', character('aiko', 'Aiko')],
      [
        'ren',
        character('ren', 'Ren', {
          promptOverride: { mode: 'chunks', refs: { subject: [pin('take1')] } },
        }),
      ],
    ]),
    locations: new Map([
      ['classroom', location('classroom', ['evening'])],
      [
        'rooftop',
        location('rooftop', ['sunset'], {
          variants: [
            {
              id            : 'sunset',
              description   : '',
              promptOverride: {
                mode: 'chunks',
                refs: {
                  mood: [
                    pin('plate1', { kind: 'plate', locationId: 'classroom', variant: 'evening' }),
                  ],
                },
              },
            },
          ],
        }),
      ],
      ['hall', location('hall', ['night'])],
    ]),
    takes     : new Set(['take1']),
    pages     : [{ path: 'wiki/aiko.md', text: "Aiko's diary. Aikos is not her. AIKO again." }],
    ...patch,
  };
}

type Applied = Extract<EntityOp, { ok: true }>;

const accepted = (op: EntityOp): Applied => {
  if (!op.ok) throw new Error(`refused: ${op.error}`);
  return op;
};
const error = (op: EntityOp): string => (op.ok ? 'accepted' : op.error);
const scene = (op: Applied, id: string): Scene => {
  const found = op.op.writes.find((s) => s.id === id);
  if (!found) throw new Error(`${id} was not written`);
  return found;
};
const board = (op: Applied, sceneId: string): Shot[] => {
  const found = op.shots.writes.get(sceneId);
  if (!found) throw new Error(`${sceneId}'s storyboard was not written`);
  return found;
};

describe('deleteCharacter', () => {
  it('turns every line the character speaks into narration by default', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'narrate' }));
    expect(scene(op, 'arrival').lines[1]).toEqual({
      id  : 'arrival:L2',
      kind: 'narration',
      text: "You're late.",
    });
    expect(scene(op, 'rooftop').lines[0]).toMatchObject({ kind: 'narration' });
    expect(op.op.retyped).toEqual(['arrival:L2', 'rooftop:L1']);
    expect(op.notes[0]).toBe('Turns the 2 lines aiko speaks in 2 scenes into narration.');
  });

  it('deletes those lines instead, and the shots covering them lose the coverage', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'delete' }));
    expect(scene(op, 'arrival').lines.map((l) => l.id)).toEqual(['arrival:L1', 'arrival:L3']);
    expect(op.op.retired).toEqual(['arrival:L2', 'rooftop:L1']);
    expect(board(op, 'arrival')[0]!.coversLines).toEqual(['arrival:L3']);
  });

  it('gives them to mergeInto, keeping the cue’s extension', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'merge', mergeInto: 'ren' }));
    expect(scene(op, 'arrival').lines[1]).toMatchObject({
      kind   : 'dialogue',
      speaker: 'REN (V.O.)',
    });
    expect(scene(op, 'rooftop').lines[0]).toMatchObject({ speaker: 'REN' });
  });

  it('refuses a merge with nobody, with itself, or with a character that does not exist', () => {
    expect(error(deleteCharacter(world(), { id: 'aiko', lines: 'merge' }))).toMatch(
      /Choose mergeInto/,
    );
    expect(
      error(deleteCharacter(world(), { id: 'aiko', lines: 'merge', mergeInto: 'aiko' })),
    ).toMatch(/its own lines/);
    expect(
      error(deleteCharacter(world(), { id: 'aiko', lines: 'merge', mergeInto: 'kei' })),
    ).toMatch(/No character "kei"/);
  });

  it('refuses a character the project does not have', () => {
    expect(error(deleteCharacter(world(), { id: 'kei', lines: 'narrate' }))).toBe(
      'No character "kei".',
    );
  });

  it('clears the outfit markers that name it', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'narrate' }));
    expect(scene(op, 'arrival').outfits).toBeUndefined();
    expect(op.notes).toContain('Clears 1 outfit marker naming aiko.');
  });

  it('takes it out of every shot, leaving a shot with nobody as a background plate', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'narrate' }));
    expect(board(op, 'arrival')[0]!.subjects).toEqual([{ characterId: 'ren' }]);
    const plate = board(op, 'rooftop')[0]!;
    expect(plate.subjects).toEqual([]);
    expect(plate.castOptional).toBeUndefined();
    expect(op.notes).toContain('Takes aiko out of 2 shots; 1 shot is left as a background plate.');
  });

  it('drops pins on its portrait or on any of its takes, from shots and sheets alike', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'narrate' }));
    expect(board(op, 'arrival')[0]!.promptOverride?.refs).toEqual({ subject: [pin('kept')] });
    expect(op.sheets).toEqual([
      { kind: 'character', id: 'ren', edit: { promptOverride: { mode: 'chunks' } } },
    ]);
    expect(op.notes).toContain('Drops 3 reference images of aiko from other prompts.');
  });

  it('lists every shot whose inputs change, so the host can price them', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'narrate' }));
    expect(op.changed.map((c) => c.shot.id)).toEqual(['arrival__a', 'rooftop__a']);
  });

  it('lists prose that names it as a whole word, and rewrites none of it', () => {
    const op = accepted(deleteCharacter(world(), { id: 'aiko', lines: 'narrate' }));
    expect(op.mentions).toEqual([
      { kind: 'scene', where: 'arrival', count: 1 },
      { kind: 'page', where: 'wiki/aiko.md', count: 2 },
    ]);
  });
});

describe('deleteLocation', () => {
  /** The fixture with no takes: the ones it lists are aiko's. */
  const places = (): EntityWorld => world({ takes: new Set() });

  it('refuses while scenes are set there and no replacement is named, naming them', () => {
    expect(error(deleteLocation(places(), { id: 'classroom' }))).toMatch(
      /1 scene is set at classroom \(arrival\)\. Choose replaceWith/,
    );
  });

  it('refuses a replacement that is itself or that does not exist', () => {
    expect(error(deleteLocation(places(), { id: 'classroom', replaceWith: 'classroom' }))).toMatch(
      /cannot replace itself/,
    );
    expect(error(deleteLocation(places(), { id: 'classroom', replaceWith: 'gym' }))).toMatch(
      /No location "gym"/,
    );
  });

  it('sets each scene in the replacement, keeping INT./EXT. and the time of day', () => {
    const op = accepted(deleteLocation(places(), { id: 'classroom', replaceWith: 'hall' }));
    expect(scene(op, 'arrival')).toMatchObject({
      location       : 'hall',
      locationVariant: 'evening',
      headingPrefix  : 'INT.',
    });
    expect(op.op.relocated).toEqual([['arrival', 'evening']]);
  });

  it('counts every shot in a moved scene as changed, restaged or not', () => {
    const op = accepted(deleteLocation(places(), { id: 'classroom', replaceWith: 'hall' }));
    expect(op.changed).toEqual([expect.objectContaining({ sceneId: 'arrival', location: 'hall' })]);
  });

  it('drops pins on its plates from other locations’ sheets', () => {
    const op = accepted(deleteLocation(places(), { id: 'classroom', replaceWith: 'hall' }));
    expect(op.sheets).toEqual([
      { kind: 'location', id: 'rooftop', edit: { variants: ['sunset'] } },
    ]);
  });

  it('deletes a location no scene is set at without needing a replacement', () => {
    const op = accepted(deleteLocation(places(), { id: 'hall' }));
    expect(op.op.writes).toEqual([]);
    expect(op.notes).toEqual([]);
  });
});

describe('dropPins', () => {
  it('removes the key of a chunk left with no references, and an override left empty', () => {
    const override = { mode: 'chunks' as const, refs: { a: [pin('x')], b: [pin('y')] } };
    expect(dropPins(override, (r) => r.pin === 'x')).toEqual({
      override: { mode: 'chunks', refs: { b: [pin('y')] } },
      dropped : 1,
    });
    expect(dropPins(override, () => true)).toEqual({ override: undefined, dropped: 2 });
  });

  it('keeps everything else an override says', () => {
    const override = { mode: 'chunks' as const, mute: ['m'], refs: { a: [pin('x')] } };
    expect(dropPins(override, () => true).override).toEqual({ mode: 'chunks', mute: ['m'] });
  });
});

describe('forgetPicture', () => {
  it('drops every pin on the picture and clears each shot showing it, leaving the rest', () => {
    const w = world({
      characters: new Map([
        [
          'aiko',
          character('aiko', 'Aiko', {
            promptOverride: { mode: 'chunks', refs: { face: [pin('gone'), pin('kept')] } },
          }),
        ],
      ]),
      locations: new Map([
        [
          'rooftop',
          location('rooftop', ['sunset'], {
            variants: [
              {
                id            : 'sunset',
                description   : '',
                promptOverride: { mode: 'chunks', refs: { sky: [pin('gone')] } },
              },
            ],
          }),
        ],
      ]),
      shots: new Map([
        [
          'rooftop',
          [
            shot('s1', 'rooftop', ['aiko'], { image: 'gone' }),
            shot('s2', 'rooftop', ['aiko'], { image: 'kept' }),
          ],
        ],
      ]),
    });
    const op = forgetPicture(w, 'gone');
    expect(op).toMatchObject({ pins: 2, images: 1 });
    expect(op.sheets.map((e) => `${e.kind}:${e.id}`)).toEqual([
      'character:aiko',
      'location:rooftop',
    ]);
    const board = op.shots.get('rooftop')!;
    expect(board[0]!.image).toBeUndefined();
    expect(board[1]!.image).toBe('kept');
    expect(op.changed.map((c) => c.shot.id)).toEqual(['s1']);
  });

  it('changes nothing for a picture nothing names', () => {
    const op = forgetPicture(world(), 'nobody');
    expect(op).toMatchObject({ pins: 0, images: 0, sheets: [], changed: [] });
    expect(op.shots.size).toBe(0);
  });
});
