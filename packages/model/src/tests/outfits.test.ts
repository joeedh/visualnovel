import type { Character, Scene } from '@vn/types';
import { outfitFor, outfitText } from '../outfits.js';

const aiko: Character = {
  id: 'aiko',
  name: 'Aiko',
  description: 'A transfer student.',
  traits: [],
  palette: [],
  status: 'approved',
  defaultOutfit: 'uniform',
  outfits: [
    { id: 'uniform', characterId: 'aiko', description: 'navy winter uniform' },
    { id: 'track', characterId: 'aiko', description: '' },
  ],
};

const sceneWith = (outfits?: Record<string, string>): Pick<Scene, 'outfits'> => ({ outfits });

describe('outfitFor', () => {
  it('takes the shot subject over everything, and says so', () => {
    const r = outfitFor(
      { characterId: 'aiko', outfit: 'track' },
      sceneWith({ aiko: 'swim' }),
      aiko,
    );
    expect(r).toEqual({ id: 'track', origin: 'shot' });
  });

  it('takes the scene marker when the subject does not override', () => {
    const r = outfitFor({ characterId: 'aiko' }, sceneWith({ aiko: 'swim' }), aiko);
    expect(r).toEqual({ id: 'swim', origin: 'scene' });
  });

  it("falls through a marker that names someone else to the character's default", () => {
    const r = outfitFor({ characterId: 'aiko' }, sceneWith({ ren: 'swim' }), aiko);
    expect(r).toEqual({ id: 'uniform', origin: 'default' });
  });

  it('answers for a subject the model does not have, rather than throwing', () => {
    expect(outfitFor({ characterId: 'ghost' }, sceneWith(), undefined)).toEqual({
      id: 'default',
      origin: 'default',
    });
    expect(outfitFor({ characterId: 'ghost' }, sceneWith({ ghost: 'suit' }), undefined)).toEqual({
      id: 'suit',
      origin: 'scene',
    });
  });
});

describe('outfitText', () => {
  it('says the description when there is one', () => {
    expect(outfitText(aiko, 'uniform')).toBe('navy winter uniform');
  });

  // Until a description exists, every prompt is byte-identical to the one the id produced, so
  // no task rehashes and no art is re-rendered, which is what makes adding a wardrobe free.
  it('says the id when there is not, and for an outfit the character never authored', () => {
    expect(outfitText(aiko, 'track')).toBe('track');
    expect(outfitText(aiko, 'swim')).toBe('swim');
    expect(outfitText(undefined, 'uniform')).toBe('uniform');
  });
});
