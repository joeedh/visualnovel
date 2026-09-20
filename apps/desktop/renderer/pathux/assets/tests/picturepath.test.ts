import { pictureAsset, pictureSrc } from '../picturepath.js';

const HASH = 'f'.repeat(64);
const BASE = `assets/objects/${HASH}.png`;
const FRAME = `vngen/build/assets/${HASH}.webp`;

describe('pictureSrc', () => {
  it('climbs out of the document directory to either root', () => {
    expect(pictureSrc('characters/aiko/character.md', BASE)).toBe(`../../${BASE}`);
    expect(pictureSrc('wiki/lore.md', FRAME)).toBe(`../${FRAME}`);
    expect(pictureSrc('README.md', BASE)).toBe(BASE);
  });

  it('drops the directories the document already shares with the file', () => {
    expect(pictureSrc('assets/notes.md', BASE)).toBe(`objects/${HASH}.png`);
    expect(pictureSrc('vngen/build/report.md', FRAME)).toBe(`assets/${HASH}.webp`);
  });
});

describe('pictureAsset', () => {
  it('reads back what pictureSrc wrote, from any document', () => {
    for (const doc of [
      'characters/aiko/character.md',
      'wiki/lore.md',
      'README.md',
      'assets/notes.md',
    ]) {
      expect(pictureAsset(doc, pictureSrc(doc, BASE))).toEqual({ hash: HASH, ext: 'png' });
      expect(pictureAsset(doc, pictureSrc(doc, FRAME))).toEqual({ hash: HASH, ext: 'webp' });
    }
    expect(pictureAsset('wiki/lore.md', `./../${BASE}`)).toEqual({ hash: HASH, ext: 'png' });
  });

  it('leaves alone what is not a stored asset', () => {
    expect(pictureAsset('wiki/lore.md', 'https://example.com/a.png')).toBeUndefined();
    expect(pictureAsset('wiki/lore.md', 'vnasset://abc.png')).toBeUndefined();
    expect(pictureAsset('wiki/lore.md', '/assets/objects/a.png')).toBeUndefined();
    expect(pictureAsset('wiki/lore.md', '../../assets/objects/a.png')).toBeUndefined();
    expect(pictureAsset('wiki/lore.md', 'pictures/a.png')).toBeUndefined();
    expect(pictureAsset('wiki/lore.md', '../assets/objects/sub/a.png')).toBeUndefined();
    expect(pictureAsset('wiki/lore.md', '../assets/objects/noext')).toBeUndefined();
  });
});
