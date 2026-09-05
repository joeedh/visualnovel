/**
 * The art-notes rung vocabulary. Pure, so it is asserted against a hand-built model. The rungs an
 * asset offers are what both the asset editor's strip and the agent's `art_notes` show, and these
 * tests are what pin the two to the same list.
 */
import { character, location, model, scene } from '@vn/testkit';
import type { Asset, AssetBinding, AssetKind, Shot } from '@vn/types';
import { formatArtTarget, parseArtTarget, rungAt, rungsFor, type ArtTarget } from '../artnotes.js';

const aiko = { ...character('aiko'), name: 'Aiko' };
aiko.outfits = [
  { id: 'default', characterId: 'aiko', description: '' },
  { id: 'gala', characterId: 'aiko', description: 'a long green dress', artNotes: 'satin, matte' },
];
aiko.artNotes = 'soft key light';

const cafe = { ...location('cafe'), name: 'Café Mori' };
cafe.variants = [
  { id: 'day', description: '' },
  { id: 'night', description: 'after closing', artNotes: 'sodium streetlight' },
];

const shot: Shot = {
  id         : 's2',
  sceneId    : 'greet',
  framing    : 'medium',
  location   : 'day',
  subjects   : [],
  coversLines: [],
  artNotes   : 'wider than the last one',
  status     : 'pending',
};

const ctx = {
  model: model([aiko], [scene('greet', ['aiko'])], [cafe]),
  shots: new Map<string, readonly Shot[] | null>([['greet', [shot]]]),
};

/** An asset of one kind bound to one thing — the only two fields `rungsFor` reads. */
function asset(kind: AssetKind, binding: AssetBinding): Asset {
  return {
    hash: 'a'.repeat(64),
    ext : 'png',
    kind,
    sourceTask: 'b'.repeat(64),
    refs      : [],
    modelId   : 'fake',
    satisfies : [binding],
    accepted  : false,
  };
}

describe('parseArtTarget', () => {
  it('round-trips every rung the vocabulary has', () => {
    const targets: ArtTarget[] = [
      { kind: 'character', id: 'aiko' },
      { kind: 'character', id: 'aiko', outfit: 'gala' },
      { kind: 'location', id: 'cafe' },
      { kind: 'location', id: 'cafe', variant: 'night' },
      { kind: 'shot', sceneId: 'greet', shotId: 's2' },
    ];
    for (const target of targets) {
      expect(parseArtTarget(formatArtTarget(target))).toEqual(target);
    }
  });

  it('refuses anything the five rungs do not name', () => {
    for (const bad of [
      '',
      'aiko',
      ':aiko',
      'scene:greet',
      'shot:greet',
      'character:',
      'character:aiko/',
      'character:aiko/gala/extra',
    ]) {
      expect(parseArtTarget(bad)).toBeUndefined();
    }
  });
});

describe('rungAt', () => {
  it('answers with what is authored there, and the rung it is', () => {
    expect(rungAt({ kind: 'character', id: 'aiko' }, ctx)).toEqual({
      target: 'character:aiko',
      label : 'Aiko',
      notes : 'soft key light',
    });
    expect(rungAt({ kind: 'character', id: 'aiko', outfit: 'gala' }, ctx)).toMatchObject({
      label: 'Aiko — gala',
      notes: 'satin, matte',
    });
    expect(rungAt({ kind: 'location', id: 'cafe', variant: 'night' }, ctx)).toMatchObject({
      label: 'Café Mori — night',
      notes: 'sodium streetlight',
    });
    expect(rungAt({ kind: 'shot', sceneId: 'greet', shotId: 's2' }, ctx)).toMatchObject({
      label: 'greet · s2',
      notes: 'wider than the last one',
    });
  });

  // A rung that exists with no notes answers differently from a rung that does not exist. An
  // authored-but-empty rung is offered for an author to fill in; a missing rung is a typo.
  it('distinguishes a silent rung from a missing one', () => {
    expect(rungAt({ kind: 'location', id: 'cafe', variant: 'day' }, ctx)).toEqual({
      target: 'location:cafe/day',
      label : 'Café Mori — day',
    });
    expect(rungAt({ kind: 'location', id: 'cafe', variant: 'dawn' }, ctx)).toBeUndefined();
    expect(rungAt({ kind: 'character', id: 'haruki' }, ctx)).toBeUndefined();
    expect(rungAt({ kind: 'shot', sceneId: 'greet', shotId: 's9' }, ctx)).toBeUndefined();
    expect(rungAt({ kind: 'shot', sceneId: 'nowhere', shotId: 's2' }, ctx)).toBeUndefined();
  });
});

describe('rungsFor', () => {
  it('offers the rungs that actually reach the picture, widest first', () => {
    const labels = (a: Asset) => rungsFor(a, ctx).map((r) => r.target);

    expect(labels(asset('portrait', { characterId: 'aiko' }))).toEqual(['character:aiko']);
    expect(labels(asset('model_sheet', { characterId: 'aiko', outfit: 'gala' }))).toEqual([
      'character:aiko',
      'character:aiko/gala',
    ]);
    expect(labels(asset('location_ref', { locationId: 'cafe', variant: 'night' }))).toEqual([
      'location:cafe',
      'location:cafe/night',
    ]);
  });

  // The character's and the location's rungs reach a frame through the sheets and plates it
  // references; offering them here would invite an author to say the same thing twice.
  it('gives a shot frame its own rung and no other', () => {
    expect(rungsFor(asset('shot_image', { sceneId: 'greet', shotId: 's2' }), ctx)).toEqual([
      { target: 'shot:greet/s2', label: 'greet · s2', notes: 'wider than the last one' },
    ]);
  });

  it('gives a concept the entity rung alone, and an unbound asset nothing', () => {
    expect(rungsFor(asset('concept', { locationId: 'cafe', variant: 'night' }), ctx)).toEqual([
      { target: 'location:cafe', label: 'Café Mori' },
    ]);
    expect(rungsFor(asset('reference', {}), ctx)).toEqual([]);
  });
});
