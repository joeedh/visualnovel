/**
 * Covers the four enumerators the planner and the slot graph share. This does not pin the
 * planner's behaviour, which `@vn/pipeline`'s own suites cover; it pins that both callers get the
 * same answer, since a slot the graph promises and the planner never plans is the one bug this
 * shape of graph can have.
 */
import type { Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { allCharacters, allLocationVariants, reachableScenes, usedOutfits } from '../used.js';

const shot = (id: string, sceneId: string, subjects: Shot['subjects']): Shot => ({
  id,
  sceneId,
  framing : 'medium',
  location: 'day',
  subjects,
  coversLines: [],
  status     : 'pending',
});

describe('reachableScenes', () => {
  it('drops what no branch reaches', () => {
    const m = model([], [scene('a'), scene('b'), scene('orphan')], []);
    m.reachable = new Set(['a', 'b']);
    expect(reachableScenes(m).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('allCharacters', () => {
  it('draws everyone the project authored, cast or not', () => {
    const m = model(
      [character('aiko'), character('ren'), character('uncast')],
      [scene('a', ['aiko'], 'cafe'), scene('dead', ['ren'], 'cafe')],
      [location('cafe')],
    );
    m.reachable = new Set(['a']);
    expect(allCharacters(m).map((c) => c.id)).toEqual(['aiko', 'ren', 'uncast']);
  });

  it('yields no hole for a cast id the model does not have', () => {
    const m = model(
      [character('aiko')],
      [scene('a', ['aiko', 'ghost'], 'cafe')],
      [location('cafe')],
    );
    expect(allCharacters(m).map((c) => c.id)).toEqual(['aiko']);
  });
});

describe('usedOutfits', () => {
  it("puts the character's default in first, so a wardrobe-less project is unchanged", () => {
    const m = model([character('aiko')], [scene('a', ['aiko'], 'cafe')], [location('cafe')]);
    expect([...(usedOutfits(m).get('aiko') ?? [])]).toEqual(['default']);
  });

  it('adds a scene marker and a shot override on top of the default', () => {
    const s = scene('a', ['aiko'], 'cafe');
    s.outfits = { aiko: 'gala' };
    s.shots = [shot('a__1', 'a', [{ characterId: 'aiko', outfit: 'swim' }])];
    const m = model([character('aiko')], [s], [location('cafe')]);
    expect([...(usedOutfits(m).get('aiko') ?? [])]).toEqual(['default', 'gala', 'swim']);
  });

  it('honours a marker naming someone the cast list forgot', () => {
    const s = scene('a', [], 'cafe');
    s.outfits = { aiko: 'gala' };
    const m = model([character('aiko')], [s], [location('cafe')]);
    expect([...(usedOutfits(m).get('aiko') ?? [])]).toEqual(['default', 'gala']);
  });

  it('reads shot overrides from a passed map instead of Scene.shots', () => {
    // The planner omits `shots` and reads what it has populated wave by wave; a caller holding the
    // persisted decompositions passes them and gets the whole answer before anything has run.
    const s = scene('a', ['aiko'], 'cafe');
    const m = model([character('aiko')], [s], [location('cafe')]);
    const persisted = new Map([
      ['a', [shot('a__1', 'a', [{ characterId: 'aiko', outfit: 'gala' }])]],
    ]);
    expect([...(usedOutfits(m).get('aiko') ?? [])]).toEqual(['default']);
    expect([...(usedOutfits(m, persisted).get('aiko') ?? [])]).toEqual(['default', 'gala']);
  });

  it('ignores unreachable scenes entirely', () => {
    const dead = scene('dead', ['aiko'], 'cafe');
    dead.outfits = { aiko: 'gala' };
    const m = model([character('aiko')], [scene('a', ['aiko'], 'cafe'), dead], [location('cafe')]);
    m.reachable = new Set(['a']);
    expect([...(usedOutfits(m).get('aiko') ?? [])]).toEqual(['default']);
  });
});

describe('allLocationVariants', () => {
  it('takes every declared variant, not just the ones scenes name', () => {
    const cafe = location('cafe');
    cafe.variants = [
      { id: 'day', description: '' },
      { id: 'night', description: '' },
    ];
    const m = model([], [scene('a', [], 'cafe')], [cafe]);
    expect([...(allLocationVariants(m).get('cafe') ?? [])]).toEqual(['day', 'night']);
  });

  it('falls back to a day variant for a location that declares none', () => {
    const bare = location('cafe');
    bare.variants = [];
    const m = model([], [scene('a', [], 'cafe')], [bare]);
    expect([...(allLocationVariants(m).get('cafe') ?? [])]).toEqual(['day']);
  });

  it('plates a location no reachable scene sits in, and invents none the model lacks', () => {
    const m = model(
      [],
      [scene('a', [], 'cafe'), scene('dead', [], 'roof'), scene('b', [], 'nowhere')],
      [location('cafe'), location('roof')],
    );
    m.reachable = new Set(['a', 'b']);
    expect([...allLocationVariants(m).keys()]).toEqual(['cafe', 'roof']);
  });
});
