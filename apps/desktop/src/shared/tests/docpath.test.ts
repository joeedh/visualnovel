import { relativePath, resolvePath } from '../docpath.js';

describe('relativePath and resolvePath', () => {
  it('climb out of the document directory and back', () => {
    expect(relativePath('characters/aiko/character.md', 'wiki/world.md')).toBe(
      '../../wiki/world.md',
    );
    expect(relativePath('wiki/world.md', 'characters/aiko/character.md')).toBe(
      '../characters/aiko/character.md',
    );
    expect(relativePath('wiki/world.md', 'wiki/locations/school.md')).toBe('locations/school.md');
    expect(relativePath('README.md', 'wiki/world.md')).toBe('wiki/world.md');
    const pairs: [string, string][] = [
      ['characters/aiko/character.md', 'wiki/world.md'],
      ['wiki/world.md', 'wiki/world.md'],
      ['wiki/locations/school.md', 'scenes/arrival.md'],
    ];
    for (const [doc, file] of pairs) {
      expect(resolvePath(doc, relativePath(doc, file))).toBe(file);
    }
  });

  it('resolve refuses a url, an absolute path and a climb out of the workspace', () => {
    expect(resolvePath('wiki/world.md', 'https://example.com/a')).toBeUndefined();
    expect(resolvePath('wiki/world.md', 'mailto:someone@example.com')).toBeUndefined();
    expect(resolvePath('wiki/world.md', '/wiki/world.md')).toBeUndefined();
    expect(resolvePath('wiki/world.md', '../../wiki/world.md')).toBeUndefined();
    expect(resolvePath('wiki/world.md', './world.md')).toBe('wiki/world.md');
  });
});
