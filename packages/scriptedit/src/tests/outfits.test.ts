import type { Character, Scene, Shot } from '@vn/types';
import { setSceneOutfit, setShotOutfit, wardrobesOf, type WardrobeMap } from '../outfits.js';

const WARDROBES: WardrobeMap = new Map([
  ['aiko', { defaultOutfit: 'uniform', outfits: ['uniform', 'track'] }],
  ['ren', { defaultOutfit: 'uniform', outfits: ['uniform'] }],
]);

const sceneOf = (outfits?: Record<string, string>): Scene => ({
  id: 'club',
  location: 'club_room',
  characters: ['aiko', 'ren'],
  lines: [],
  choices: [],
  shots: [],
  ...(outfits ? { outfits } : {}),
});

const scenes = (scene: Scene) => new Map([[scene.id, scene]]);

const shots = (subjects: { characterId: string; outfit?: string }[]): Shot[] => [
  {
    id: 'club__beat1',
    sceneId: 'club',
    framing: 'medium',
    location: 'club_room_day',
    subjects,
    coversLines: ['club:L1'],
    status: 'generated',
  },
];

describe('wardrobesOf', () => {
  it('reads the sheet in authored order and keeps the default reachable', () => {
    const character = (id: string, defaultOutfit: string, outfits: string[]): Character => ({
      id,
      name: id,
      description: '',
      traits: [],
      palette: [],
      status: 'draft',
      defaultOutfit,
      outfits: outfits.map((o) => ({ id: o, characterId: id, description: '' })),
    });
    const map = wardrobesOf(
      new Map([
        ['aiko', character('aiko', 'uniform', ['uniform', 'track'])],
        // This sheet's outfit list never mentions its default. The default still has to be
        // nameable, or clearing an override would refuse the value it clears to
        ['ren', character('ren', 'uniform', ['coat'])],
      ]),
    );
    expect(map.get('aiko')).toEqual({ defaultOutfit: 'uniform', outfits: ['uniform', 'track'] });
    expect(map.get('ren')).toEqual({ defaultOutfit: 'uniform', outfits: ['uniform', 'coat'] });
  });
});

describe('setSceneOutfit', () => {
  it('writes the whole marker set, carrying the ones it is not changing', () => {
    const op = setSceneOutfit(scenes(sceneOf({ ren: 'uniform' })), WARDROBES, {
      scene: 'club',
      character: 'aiko',
      outfit: 'track',
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.edits).toEqual([{ sceneId: 'club', outfits: { ren: 'uniform', aiko: 'track' } }]);
    expect(op.message).toContain('"track"');
  });

  it('clears one marker and names the default it falls back to', () => {
    const op = setSceneOutfit(scenes(sceneOf({ aiko: 'track', ren: 'uniform' })), WARDROBES, {
      scene: 'club',
      character: 'aiko',
      outfit: '',
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.edits).toEqual([{ sceneId: 'club', outfits: { ren: 'uniform' } }]);
    expect(op.message).toContain('"uniform"');
  });

  it('refuses an outfit the character has not authored, listing the ones they have', () => {
    const op = setSceneOutfit(scenes(sceneOf()), WARDROBES, {
      scene: 'club',
      character: 'ren',
      outfit: 'track',
    });
    expect(op).toEqual({ ok: false, error: '"ren" has no outfit "track" — they have "uniform".' });
  });

  it('refuses a scene and a character it does not have', () => {
    const noScene = setSceneOutfit(scenes(sceneOf()), WARDROBES, {
      scene: 'gate',
      character: 'aiko',
      outfit: 'track',
    });
    expect(noScene).toMatchObject({ ok: false, error: 'No scene "gate".' });
    const noCharacter = setSceneOutfit(scenes(sceneOf()), WARDROBES, {
      scene: 'club',
      character: 'kaito',
      outfit: 'track',
    });
    expect(noCharacter).toMatchObject({ ok: false, error: 'No character "kaito".' });
  });

  // A `noop` is reported rather than a plain refusal, so a UI listing the wardrobe can drop the
  // entry already in force instead of offering it and then refusing the click
  it('marks a change that would change nothing as a noop, in both directions', () => {
    const same = setSceneOutfit(scenes(sceneOf({ aiko: 'track' })), WARDROBES, {
      scene: 'club',
      character: 'aiko',
      outfit: 'track',
    });
    expect(same).toMatchObject({ ok: false, noop: true });
    const alreadyClear = setSceneOutfit(scenes(sceneOf()), WARDROBES, {
      scene: 'club',
      character: 'aiko',
      outfit: '',
    });
    expect(alreadyClear).toMatchObject({ ok: false, noop: true });
  });
});

describe('setShotOutfit', () => {
  it('sets one subject and leaves the others as authored', () => {
    const op = setShotOutfit(
      shots([{ characterId: 'aiko' }, { characterId: 'ren', outfit: 'uniform' }]),
      sceneOf(),
      WARDROBES,
      { shot: 'club__beat1', character: 'aiko', outfit: 'track' },
    );
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.subjects).toEqual([
      { characterId: 'aiko', outfit: 'track' },
      { characterId: 'ren', outfit: 'uniform' },
    ]);
  });

  it('clears an override to a bare subject, and says which level answers instead', () => {
    const scene = sceneOf({ aiko: 'track' });
    const op = setShotOutfit(
      shots([{ characterId: 'aiko', outfit: 'uniform' }]),
      scene,
      WARDROBES,
      {
        shot: 'club__beat1',
        character: 'aiko',
        outfit: '',
      },
    );
    if (!op.ok) throw new Error(op.error);
    // The property is removed rather than set to '', because `outfitFor` reads absent as inherit
    expect(op.shots[0]!.subjects).toEqual([{ characterId: 'aiko' }]);
    expect(op.shots[0]!.subjects[0]).not.toHaveProperty('outfit');
    expect(op.message).toContain('"track"');
    expect(op.message).toContain('scene marker');
  });

  it('names the character sheet when no scene marker would answer', () => {
    const op = setShotOutfit(
      shots([{ characterId: 'aiko', outfit: 'track' }]),
      sceneOf(),
      WARDROBES,
      {
        shot: 'club__beat1',
        character: 'aiko',
        outfit: '',
      },
    );
    if (!op.ok) throw new Error(op.error);
    expect(op.message).toContain('"uniform"');
    expect(op.message).toContain('character sheet');
  });

  it('refuses a shot it does not have and a subject the shot does not have', () => {
    const missing = setShotOutfit(shots([{ characterId: 'aiko' }]), sceneOf(), WARDROBES, {
      shot: 'club__beat9',
      character: 'aiko',
      outfit: 'track',
    });
    expect(missing).toMatchObject({ ok: false, error: 'No shot "club__beat9" in club.' });
    const offscreen = setShotOutfit(shots([{ characterId: 'aiko' }]), sceneOf(), WARDROBES, {
      shot: 'club__beat1',
      character: 'ren',
      outfit: 'uniform',
    });
    expect(offscreen).toMatchObject({ ok: false, error: 'Shot club__beat1 has no subject "ren".' });
  });

  // A shot decomposed before outfits were authorable carries an explicit outfit, so a scene marker
  // cannot reach it. Setting the override to what it already says is still nothing to write.
  it('marks setting the override it already carries as a noop', () => {
    const op = setShotOutfit(
      shots([{ characterId: 'aiko', outfit: 'uniform' }]),
      sceneOf(),
      WARDROBES,
      {
        shot: 'club__beat1',
        character: 'aiko',
        outfit: 'uniform',
      },
    );
    expect(op).toMatchObject({ ok: false, noop: true });
  });
});
