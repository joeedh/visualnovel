/**
 * A rename is text in, text out — so where the name lives, and what is left untouched around it,
 * are both testable without a workspace.
 */
import { parseFrontMatter } from '@vn/parse';
import { renameInText } from '../rename.js';

/** The text a successful rename produced, so a case that refused fails loudly at the assertion. */
function renamed(path: string, text: string, name: string): string {
  const result = renameInText(path, text, name);
  if (!result.ok) throw new Error(result.reason);
  return result.text;
}

describe('renameInText', () => {
  const sheet = ['---', 'id: aiko', 'name: Aiko', 'type: character', '---', '', '# Aiko', ''].join(
    '\n',
  );

  it('renames a character sheet through its name field, by its conventional home', () => {
    const out = renamed('characters/aiko/character.md', sheet, 'Aiko Tanaka');
    expect(parseFrontMatter(out).data).toMatchObject({ id: 'aiko', name: 'Aiko Tanaka' });
  });

  it('leaves the id alone: the file does not move, so nothing pointing at it breaks', () => {
    const out = renamed('characters/aiko/character.md', sheet, 'Someone Else');
    expect(parseFrontMatter(out).data['id']).toBe('aiko');
  });

  it('renames a location sheet', () => {
    const doc = ['---', 'id: cafe', 'name: Café', 'type: location', '---', '', 'Warm.', ''].join(
      '\n',
    );
    const out = renamed('locations/cafe.md', doc, 'Café Mori');
    expect(parseFrontMatter(out).data).toMatchObject({ id: 'cafe', name: 'Café Mori' });
  });

  it('takes the kind from a type: tag when the sheet is filed under wiki/', () => {
    const out = renamed('wiki/aiko.md', sheet, 'Aiko Tanaka');
    expect(parseFrontMatter(out).data['name']).toBe('Aiko Tanaka');
  });

  it("rewrites a note's front-matter title, which is where the bible read it", () => {
    const doc = ['---', 'title: Old', 'tags: [lore]', '---', '', 'Body.', ''].join('\n');
    const out = renamed('wiki/note.md', doc, 'New');
    expect(parseFrontMatter(out).data['title']).toBe('New');
    // Spliced, not re-serialized: the author ordered these keys and the body is untouched.
    expect(out).toContain('tags: [lore]');
    expect(out.endsWith('\nBody.\n')).toBe(true);
  });

  it('rewrites the first H1 when there is no title, and only the first', () => {
    const out = renamed('wiki/note.md', '# Old\n\nText.\n\n# Also old\n', 'New');
    expect(out).toBe('# New\n\nText.\n\n# Also old\n');
  });

  it('does not read a section heading as the title', () => {
    const out = renamed('wiki/note.md', '## Section\n\nText.\n', 'New');
    expect(out).toBe('# New\n\n## Section\n\nText.\n');
  });

  it('adds a heading to a page titled only by its filename, keeping the front-matter', () => {
    const out = renamed('wiki/note.md', '---\ntags: [lore]\n---\n\nText.\n', 'New');
    expect(out).toBe('---\ntags: [lore]\n---\n\n# New\n\nText.\n');
  });

  it('refuses a blank name rather than writing an untitled document', () => {
    expect(renameInText('wiki/note.md', '# Old\n', '  ')).toEqual({
      ok: false,
      reason: expect.stringContaining('blank'),
    });
  });

  it('trims the name it was given', () => {
    expect(renamed('wiki/note.md', '# Old\n', '  New  ')).toBe('# New\n');
  });
});
