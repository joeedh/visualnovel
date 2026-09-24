import { COMPLETION_ROWS, filterTargets, linkHref, linkTargets, linkedNode } from '../doclinks.js';
import type { DocNode } from '../../../../src/shared/ipc.js';

const roots: DocNode[] = [
  {
    id      : 'group:story',
    kind    : 'dir',
    label   : 'Story',
    children: [
      { id: 'scene:arrival', kind: 'scene', label: 'arrival', path: 'scenes/arrival.md' },
      { id: 'scene:ending', kind: 'scene', label: 'ending', path: 'scenes/ending.md' },
    ],
  },
  {
    id      : 'group:characters',
    kind    : 'dir',
    label   : 'Characters',
    children: [
      {
        id   : 'character:aiko',
        kind : 'character',
        label: 'Aiko',
        path : 'characters/aiko/character.md',
      },
      { id: 'character:ghost', kind: 'character', label: 'Ghost' },
    ],
  },
  {
    id      : 'group:wiki',
    kind    : 'wikidir',
    label   : 'Wiki',
    children: [
      { id: 'wiki:wiki/world.md', kind: 'wiki', label: 'world', path: 'wiki/world.md' },
      { id: 'file:wiki/notes.txt', kind: 'file', label: 'notes.txt', path: 'wiki/notes.txt' },
      { id: 'file:wiki/world.md', kind: 'file', label: 'world.md', path: 'wiki/world.md' },
    ],
  },
  {
    id      : 'group:assets',
    kind    : 'assetkind',
    label   : 'Assets',
    children: [{ id: 'asset:abc', kind: 'asset', label: 'Aiko — uniform' }],
  },
];

describe('linkTargets and filterTargets', () => {
  it('lists every markdown document once, in tree order', () => {
    expect(linkTargets(roots).map((t) => t.id)).toEqual([
      'scene:arrival',
      'scene:ending',
      'character:aiko',
      'wiki:wiki/world.md',
    ]);
  });

  it('matches the name before the path, and caps the rows', () => {
    const targets = linkTargets(roots);
    expect(filterTargets(targets, 'ai').map((t) => t.id)).toEqual(['character:aiko']);
    expect(filterTargets(targets, 'scenes/').map((t) => t.id)).toEqual([
      'scene:arrival',
      'scene:ending',
    ]);
    expect(filterTargets(targets, 'WORLD').map((t) => t.id)).toEqual(['wiki:wiki/world.md']);
    expect(filterTargets(targets, 'zzz')).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({
      id   : `wiki:${i}`,
      kind : 'wiki' as const,
      label: `note ${i}`,
      path : `wiki/${i}.md`,
    }));
    expect(filterTargets(many, '')).toHaveLength(COMPLETION_ROWS);
    expect(filterTargets(many, 'note 1')).toHaveLength(COMPLETION_ROWS);
  });
});

describe('linkHref and linkedNode', () => {
  const aiko = linkTargets(roots)[2]!;

  it('writes a document-relative href that resolves back to the node', () => {
    expect(linkHref('wiki/world.md', aiko)).toBe('../characters/aiko/character.md');
    expect(linkedNode('wiki/world.md', '../characters/aiko/character.md', roots)).toBe(aiko);
    expect(linkedNode('scenes/arrival.md', 'ending.md', roots)?.id).toBe('scene:ending');
  });

  it('resolves a stored picture to an asset node', () => {
    const hash = 'e'.repeat(64);
    expect(linkedNode('wiki/world.md', `../assets/objects/${hash}.png`, roots)).toEqual({
      id   : `asset:${hash}`,
      kind : 'asset',
      label: hash,
    });
  });

  it('answers nothing for a url or a path the tree does not show', () => {
    expect(linkedNode('wiki/world.md', 'https://example.com', roots)).toBeUndefined();
    expect(linkedNode('wiki/world.md', 'notes.txt', roots)).toBeUndefined();
    expect(linkedNode('wiki/world.md', '../characters/ghost/character.md', roots)).toBeUndefined();
  });
});
