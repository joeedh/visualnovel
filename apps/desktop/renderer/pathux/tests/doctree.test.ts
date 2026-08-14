import {
  assetGroups,
  backlinkSubject,
  defaultExpanded,
  findNode,
  flattenTree,
  nodeIsSelected,
  nodeKey,
  selectionForNode,
  toggleExpanded,
  type DocRow,
} from '../doctree.js';
import type { Selection } from '../selection.js';
import type { DocNode, EntityLinks } from '../../../src/shared/ipc.js';

const NONE: Selection = { sceneId: '', shotId: '', characterId: '', docPath: '' };

const node = (id: string, kind: DocNode['kind'], over: Partial<DocNode> = {}): DocNode => ({
  id,
  kind,
  label: id,
  ...over,
});

const TREE: DocNode[] = [
  node('branch:story', 'branch', {
    children: [
      node('scene:greet', 'scene', {
        path: 'scenes/greet.md',
        children: [node('shot:greet/greet__s1', 'shot', { badge: 'wide' })],
      }),
      node('scene:leave', 'scene', { path: 'scenes/leave.md', badge: 'unreachable' }),
    ],
  }),
  node('branch:characters', 'branch', {
    children: [node('character:aiko', 'character', { path: 'characters/aiko/character.md' })],
  }),
  node('branch:wiki', 'branch'),
];

const ids = (rows: DocRow[]): string[] => rows.map((row) => row.node.id);

describe('flattenTree', () => {
  it('draws only the roots when nothing is expanded', () => {
    expect(ids(flattenTree(TREE, new Set()))).toEqual([
      'branch:story',
      'branch:characters',
      'branch:wiki',
    ]);
  });

  it('draws a branch it is expanded on, and stops at its collapsed children', () => {
    expect(ids(flattenTree(TREE, new Set(['branch:story'])))).toEqual([
      'branch:story',
      'scene:greet',
      'scene:leave',
      'branch:characters',
      'branch:wiki',
    ]);
  });

  it('carries depth down, so indentation is not the caller’s arithmetic', () => {
    const rows = flattenTree(TREE, new Set(['branch:story', 'scene:greet']));
    expect(rows.map((row) => [row.node.id, row.depth])).toContainEqual(['shot:greet/greet__s1', 2]);
  });

  // The twisty is drawn from `expandable`, so a childless node marked expanded must not get one:
  // an author clicking a twisty that opens nothing is looking at a lie about the shape.
  it('never calls a childless node expandable, even when the set names it', () => {
    const rows = flattenTree(TREE, new Set(['branch:wiki']));
    const wiki = rows.find((row) => row.node.id === 'branch:wiki')!;
    expect(wiki.expandable).toBe(false);
    expect(wiki.expanded).toBe(false);
  });
});

describe('toggleExpanded', () => {
  it('opens what is closed and closes what is open, without touching the set it was given', () => {
    const open = new Set(['branch:story']);
    expect([...toggleExpanded(open, 'branch:wiki')].sort()).toEqual([
      'branch:story',
      'branch:wiki',
    ]);
    expect([...toggleExpanded(open, 'branch:story')]).toEqual([]);
    expect([...open]).toEqual(['branch:story']);
  });
});

describe('defaultExpanded', () => {
  it('opens every root that has something under it, and no further', () => {
    expect([...defaultExpanded(TREE)]).toEqual(['branch:story', 'branch:characters']);
  });
});

describe('selectionForNode', () => {
  it('names the scene and its sheet', () => {
    expect(selectionForNode(TREE[0]!.children![0]!, NONE)).toEqual({
      sceneId: 'greet',
      shotId: '',
      characterId: '',
      docPath: 'scenes/greet.md',
    });
  });

  it('drops a shot belonging to another scene, and keeps one belonging to this one', () => {
    const greet = TREE[0]!.children![0]!;
    expect(selectionForNode(greet, { ...NONE, shotId: 'leave__s1' }).shotId).toBe('');
    expect(selectionForNode(greet, { ...NONE, shotId: 'greet__s2' }).shotId).toBe('greet__s2');
  });

  it('names the shot and the scene it is filed under', () => {
    const shot = TREE[0]!.children![0]!.children![0]!;
    expect(selectionForNode(shot, NONE)).toMatchObject({
      sceneId: 'greet',
      shotId: 'greet__s1',
    });
  });

  it('names a character and opens its sheet', () => {
    expect(selectionForNode(TREE[1]!.children![0]!, NONE)).toEqual({
      sceneId: '',
      shotId: '',
      characterId: 'aiko',
      docPath: 'characters/aiko/character.md',
    });
  });

  it('names a wiki note by its path, there being no id for one', () => {
    const note = node('wiki:lore/houses.md', 'wiki', { path: 'wiki/lore/houses.md' });
    expect(selectionForNode(note, NONE).docPath).toBe('wiki/lore/houses.md');
  });

  /**
   * The clicks that must cost nothing. A branch and a `wikidir` are opened, an asset has no
   * authored identity, and `more` stands for rows that were dropped — none of them is a place.
   */
  it('returns the very same selection for a node that names nothing', () => {
    for (const kind of ['branch', 'wikidir', 'dir', 'assetkind', 'asset', 'more'] as const) {
      const current: Selection = { ...NONE, sceneId: 'greet', docPath: 'wiki/a.md' };
      expect(selectionForNode(node(`${kind}:x`, kind), current)).toBe(current);
    }
  });

  it('leaves an entity with no sheet on the document it was already on', () => {
    const orphan = node('character:rin', 'character');
    expect(selectionForNode(orphan, { ...NONE, docPath: 'wiki/a.md' })).toEqual({
      ...NONE,
      characterId: 'rin',
      docPath: 'wiki/a.md',
    });
  });
});

describe('nodeIsSelected', () => {
  const scene = TREE[0]!.children![0]!;
  const shot = scene.children![0]!;
  const character = TREE[1]!.children![0]!;

  it('lights the scene and the shot inside it together, which is what is selected', () => {
    const sel: Selection = { ...NONE, sceneId: 'greet', shotId: 'greet__s1' };
    expect(nodeIsSelected(scene, sel)).toBe(true);
    expect(nodeIsSelected(shot, sel)).toBe(true);
    expect(nodeIsSelected(TREE[0]!.children![1]!, sel)).toBe(false);
  });

  // A character is selected by id, not by the file it happens to live in — so the sheet row in
  // the file tree lights and the character row does not, which is the honest pair.
  it('lights a document node by path, and an entity node only by id', () => {
    const path = 'characters/aiko/character.md';
    const sel: Selection = { ...NONE, docPath: path };
    expect(nodeIsSelected(character, sel)).toBe(false);
    expect(nodeIsSelected(node(`file:${path}`, 'file', { path }), sel)).toBe(true);
  });

  it('lights nothing when nothing is selected', () => {
    for (const n of [scene, shot, character, TREE[0]!]) expect(nodeIsSelected(n, NONE)).toBe(false);
  });
});

describe('backlinkSubject', () => {
  it('follows the selected character, whoever selected them', () => {
    expect(backlinkSubject('', { ...NONE, characterId: 'aiko' })).toBe('character:aiko');
  });

  it('stays on a location while one is the last thing clicked here', () => {
    expect(backlinkSubject('location:rooftop', { ...NONE, characterId: 'aiko' })).toBe(
      'location:rooftop',
    );
  });

  it('names nobody when nobody is named', () => {
    expect(backlinkSubject('scene:greet', NONE)).toBe('');
    expect(backlinkSubject('', NONE)).toBe('');
  });
});

describe('findNode', () => {
  it('reaches a node at any depth, and answers nothing for one that is not there', () => {
    expect(findNode(TREE, 'shot:greet/greet__s1')?.badge).toBe('wide');
    expect(findNode(TREE, 'character:rin')).toBeUndefined();
  });
});

describe('assetGroups', () => {
  const links = (assets: EntityLinks['assets']): EntityLinks => ({
    assets,
    scenes: [],
    shots: [],
  });
  const asset = (hash: string, kind: string) =>
    ({ hash, ext: 'png', kind, accepted: false, base: true }) as EntityLinks['assets'][number];

  it('gathers by kind, in the order the manifest gave them', () => {
    const groups = assetGroups(
      links([
        asset('a', 'portrait'),
        asset('b', 'model_sheet'),
        asset('c', 'portrait'),
        asset('d', 'model_sheet'),
      ]),
    );
    expect(groups.map((g) => g.kind)).toEqual(['portrait', 'model_sheet']);
    expect(groups[0]!.assets.map((a) => a.hash)).toEqual(['a', 'c']);
    expect(groups[1]!.assets.map((a) => a.hash)).toEqual(['b', 'd']);
  });

  it('is empty for an entity nothing has been generated for', () => {
    expect(assetGroups(links([]))).toEqual([]);
  });
});

describe('nodeKey', () => {
  it('is everything after the kind, colons in the rest included', () => {
    expect(nodeKey(node('shot:greet/greet__s1', 'shot'))).toBe('greet/greet__s1');
    expect(nodeKey(node('more:assetkind:portrait', 'more'))).toBe('assetkind:portrait');
  });
});
