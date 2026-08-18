/**
 * The document tree is a projection, so most of it is testable with no filesystem at all — the
 * end-to-end case at the bottom is what proves the projection is fed the real thing.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { SlotGraph, SlotNode } from '@vn/artgen';
import type { Asset, ProjectModel, RefBinding, Shot } from '@vn/types';
import type { LoadedInputs } from '@vn/parse';
import type { DocNode } from '../../shared/ipc.js';
import { buildDocTree, fileTree, type DocTreeInput } from '../doctree.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent: () => {},
  requestPlan: () => Promise.resolve({ approved: false }),
  requestAnswer: () => Promise.resolve(''),
  requestConfirm: () => Promise.resolve(false),
  pushBusy: () => {},
};

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const at = (...parts: string[]) => [ROOT, ...parts].join(process.platform === 'win32' ? '\\' : '/');

const scene = (id: string, over: Partial<Shot> = {}): Shot => ({
  id: `${id}-s1`,
  sceneId: id,
  framing: 'wide',
  location: 'gate',
  subjects: [{ characterId: 'aiko' }],
  coversLines: [],
  status: 'pending',
  ...over,
});

const asset = (hash: string, over: Partial<Asset> = {}): Asset => ({
  hash,
  ext: 'png',
  kind: 'portrait',
  sourceTask: 't',
  refs: [],
  modelId: 'm',
  satisfies: [{ characterId: 'aiko' }],
  accepted: false,
  ...over,
});

function makeInput(over: Partial<DocTreeInput> = {}): DocTreeInput {
  const model = {
    title: 'T',
    characters: new Map([
      [
        'aiko',
        {
          id: 'aiko',
          name: 'Aiko',
          description: '',
          traits: [],
          palette: [],
          status: 'approved',
          defaultOutfit: 'uniform',
          outfits: [],
        },
      ],
    ]),
    locations: new Map([
      [
        'gate',
        { id: 'gate', name: 'The gate', description: '', palette: [], variants: [], mined: true },
      ],
    ]),
    scenes: new Map([
      [
        'arrival',
        { id: 'arrival', location: 'gate', characters: ['aiko'], lines: [], choices: [] },
      ],
      ['orphan', { id: 'orphan', location: 'gate', characters: [], lines: [], choices: [] }],
    ]),
    reachable: new Set(['arrival']),
    entry: 'arrival',
    diagnostics: [],
  } as unknown as ProjectModel;

  const inputs = {
    characterDocs: [{ id: 'aiko', file: at('wiki', 'cast', 'aiko.md') }],
    locationDocs: [{ id: 'gate', file: at('locations', 'gate.md') }],
    sceneDocs: [
      { id: 'arrival', file: at('scenes', 'arrival.md') },
      { id: 'orphan', file: at('scenes', 'orphan.md') },
    ],
    diagnostics: [],
  } as unknown as LoadedInputs;

  return {
    root: ROOT,
    model,
    inputs,
    manifest: [
      asset('a'.repeat(64), { accepted: true }),
      asset('b'.repeat(64), {
        kind: 'shot_image',
        satisfies: [{ sceneId: 'arrival', shotId: 'arrival-s1' }],
      }),
    ],
    shots: new Map<string, Shot[] | null>([['arrival', [scene('arrival')]]]),
    bible: [
      { file: 'cast/aiko.md', title: 'Aiko', tags: ['character'], headings: [], bytes: 10 },
      { file: 'history/canal.md', title: 'The canal', tags: [], headings: [], bytes: 20 },
    ],
    wikiDir: 'wiki',
    ...over,
  };
}

const branch = (roots: DocNode[], id: string): DocNode => roots.find((n) => n.id === id)!;

describe('buildDocTree', () => {
  const tree = buildDocTree(makeInput());

  it('roots the five branches the sidebar draws', () => {
    expect(tree.roots.map((n) => n.id)).toEqual([
      'branch:story',
      'branch:characters',
      'branch:locations',
      'branch:wiki',
      'branch:assets',
    ]);
  });

  it('hangs a scene’s shots under it, and says which scene no branch reaches', () => {
    const scenes = branch(tree.roots, 'branch:story').children!;
    expect(scenes.map((s) => s.id)).toEqual(['scene:arrival', 'scene:orphan']);
    expect(scenes[0]!.children!.map((s) => s.id)).toEqual(['shot:arrival/arrival-s1']);
    expect(scenes[0]!.badge).toBeUndefined();
    expect(scenes[1]!.badge).toBe('unreachable');
    // No storyboard on disk is not the same as an empty one, and neither is a broken file.
    expect(scenes[1]!.children).toBeUndefined();
  });

  it('says so on the scene when a storyboard would not parse, rather than failing the tree', () => {
    const broken = buildDocTree(makeInput({ shots: new Map([['arrival', null]]) }));
    const scenes = branch(broken.roots, 'branch:story').children!;
    expect(scenes[0]!.badge).toBe('unreadable');
  });

  it('carries the file an entity was found in, wherever it was filed', () => {
    const characters = branch(tree.roots, 'branch:characters').children!;
    expect(characters[0]).toMatchObject({
      id: 'character:aiko',
      label: 'Aiko',
      path: 'wiki/cast/aiko.md',
      badge: 'approved',
    });
  });

  it('nests the wiki by directory and groups assets by kind, labelled base or project', () => {
    const wiki = branch(tree.roots, 'branch:wiki').children!;
    expect(wiki.map((n) => n.id)).toEqual(['wikidir:cast', 'wikidir:history']);
    expect(wiki[1]!.children!.map((n) => n.label)).toEqual(['The canal']);

    const kinds = branch(tree.roots, 'branch:assets').children!;
    expect(kinds.map((n) => [n.id, n.badge])).toEqual([
      ['assetkind:portrait', 'base'],
      ['assetkind:shot_image', 'project'],
    ]);
  });

  it('names an asset from the labels it was given, and falls back to hash8.ext', () => {
    const named = buildDocTree(makeInput({ assetLabels: new Map([['a'.repeat(64), 'Aiko']]) }));
    const kinds = branch(named.roots, 'branch:assets').children!;
    expect(kinds[0]!.children!.map((n) => n.label)).toEqual(['Aiko']);
    expect(kinds[1]!.children!.map((n) => n.label)).toEqual(['bbbbbbbb.png']);
    // An asset is addressed by hash, so no click can route it down the document-opening path.
    expect(kinds[0]!.children![0]!.path).toBeUndefined();
  });

  it('calls a frame stale rather than accepted once its scene moved on', () => {
    const base = makeInput();
    const drifted = buildDocTree({
      ...base,
      manifest: base.manifest.map((a) => (a.kind === 'shot_image' ? { ...a, accepted: true } : a)),
      shots: new Map<string, Shot[] | null>([
        [
          'arrival',
          [scene('arrival', { image: 'b'.repeat(64), proseHash: 'what it used to say' })],
        ],
      ]),
    });
    const kinds = branch(drifted.roots, 'branch:assets').children!;
    expect(kinds[1]!.children![0]!.badge).toBe('stale');
    // The portrait keeps its badge: drift is a fact about a shot, not about everything accepted.
    expect(kinds[0]!.children![0]!.badge).toBe('accepted');
  });

  it('counts what a cap dropped instead of quietly shortening the branch', () => {
    const many = new Map<string, Shot[] | null>([
      ['arrival', Array.from({ length: 5 }, (_, i) => scene('arrival', { id: `s${i}` }))],
    ]);
    const capped = buildDocTree(makeInput({ shots: many, cap: 2 }));
    const shots = branch(capped.roots, 'branch:story').children![0]!.children!;
    expect(shots.map((n) => n.label)).toEqual(['s0', 's1', '… and 3 more']);
    expect(shots[2]!.kind).toBe('more');
  });
});

describe('the Unapproved branch', () => {
  const HASH_A = 'a'.repeat(64);

  const slot = (key: string, binding: RefBinding, over: Partial<SlotNode> = {}): SlotNode => ({
    key,
    binding,
    label: key,
    refs: [],
    candidates: [],
    approved: false,
    ...over,
  });

  // The projection is what is under test, so the graph is handed over rather than built — what
  // `buildSlotGraph` puts in these fields is `slotgraph.test.ts`'s job.
  const slots = (nodes: SlotNode[]): SlotGraph => ({
    nodes: new Map(nodes.map((n) => [n.key, n])),
    dependents: new Map(),
    order: nodes.map((n) => n.key),
  });

  const portrait = slot(
    'portrait:aiko',
    { kind: 'portrait', characterId: 'aiko' },
    { candidates: [HASH_A] },
  );
  const plate = slot(
    'plate:gate/day',
    { kind: 'plate', locationId: 'gate', variant: 'day' },
    { blocked: 'The gate has no approved look yet.' },
  );

  const treeWith = (graph: SlotGraph, over: Partial<DocTreeInput> = {}): DocNode | undefined =>
    buildDocTree(makeInput({ slots: graph, ...over })).roots.find(
      (n) => n.id === 'branch:unapproved',
    );

  it('is absent entirely without a slot graph, rather than empty', () => {
    // A caller that has not built the graph must not be made to claim nothing is waiting.
    expect(buildDocTree(makeInput()).roots.map((n) => n.id)).not.toContain('branch:unapproved');
  });

  it('splits into two counted groups, sitting immediately before Assets', () => {
    const roots = buildDocTree(makeInput({ slots: slots([portrait, plate]) })).roots;
    expect(roots.map((n) => n.id)).toEqual([
      'branch:story',
      'branch:characters',
      'branch:locations',
      'branch:wiki',
      'branch:unapproved',
      'branch:assets',
    ]);

    const groups = branch(roots, 'branch:unapproved').children!;
    expect(groups.map((n) => [n.id, n.label])).toEqual([
      ['unapproved:waiting', 'Awaiting approval (1)'],
      ['unapproved:unrendered', 'Not yet rendered (1)'],
    ]);
  });

  it('reuses the Assets branch’s ids for a picture that exists, so a click routes unchanged', () => {
    const waiting = treeWith(slots([portrait]))!.children![0]!.children!;
    expect(waiting).toEqual([
      {
        id: `asset:${HASH_A}`,
        kind: 'asset',
        label: 'aaaaaaaa.png',
        badge: 'portrait',
        note: 'Waiting on approval for portrait:aiko.',
      },
    ]);
  });

  it('gives a slot with no bytes an address and its own sentence, since it has no path to hover', () => {
    const unrendered = treeWith(slots([plate]))!.children![0]!.children!;
    expect(unrendered).toEqual([
      {
        id: 'slot:plate:gate/day',
        kind: 'slot',
        label: 'plate:gate/day',
        note: 'The gate has no approved look yet.',
      },
    ]);
  });

  it('reads a portrait’s approval off the gate, never off Asset.accepted', () => {
    // `a` is `accepted: true` and still waiting: the P3 gate owns a look, and nothing else does.
    expect(treeWith(slots([portrait]))!.children![0]!.label).toBe('Awaiting approval (1)');

    const input = makeInput();
    const aiko = input.model.characters.get('aiko')!;
    const approved = {
      ...input.model,
      characters: new Map([['aiko', { ...aiko, approvedPortrait: HASH_A }]]),
    } as ProjectModel;
    expect(treeWith(slots([portrait]), { model: approved })).toBeUndefined();
  });

  it('files three unaccepted drafts as awaiting approval, never as unrendered', () => {
    // `pick` declines when candidates tie, so `hash === undefined` would report real bytes as
    // unrendered. Zero candidates is the predicate, which is what keeps the two groups disjoint.
    const hashes = ['1', '2', '3'].map((n) => n.repeat(64));
    const drafts = hashes.map((hash) =>
      asset(hash, {
        kind: 'shot_image',
        satisfies: [{ sceneId: 'arrival', shotId: 'arrival-s1' }],
      }),
    );
    const frame = slot(
      'shot:arrival/arrival-s1',
      { kind: 'shot', sceneId: 'arrival', shotId: 'arrival-s1' },
      { candidates: hashes },
    );
    const groups = treeWith(slots([frame]), { manifest: drafts })!.children!;
    expect(groups.map((n) => n.id)).toEqual(['unapproved:waiting']);
    expect(groups[0]!.children!.map((n) => n.id)).toEqual(hashes.map((h) => `asset:${h}`));
  });

  it('lists a picture bound to two slots once, and caps each group on its own', () => {
    const second = slot(
      'sheet:aiko/uniform/front',
      { kind: 'sheet', characterId: 'aiko', outfit: 'uniform', angle: 'front' },
      { candidates: [HASH_A] },
    );
    const groups = treeWith(slots([portrait, second, plate]), { cap: 1 })!.children!;
    expect(groups[0]!.children!.map((n) => n.label)).toEqual(['aaaaaaaa.png']);
    expect(groups[0]!.label).toBe('Awaiting approval (1)');
    expect(groups[1]!.children!.map((n) => n.kind)).toEqual(['slot']);
  });

  it('offers nothing for a candidate the manifest has never heard of', () => {
    // The bytes are gone; there is no picture to open and nothing an author could approve.
    const stale = slot(
      'portrait:aiko',
      { kind: 'portrait', characterId: 'aiko' },
      { candidates: ['z'.repeat(64)] },
    );
    expect(treeWith(slots([stale]))).toBeUndefined();
  });
});

describe('backlinks', () => {
  const { backlinks } = buildDocTree(makeInput());

  it('join an entity to its sheet, its art, its scenes and its shots', () => {
    expect(backlinks['character:aiko']).toEqual({
      sheet: 'wiki/cast/aiko.md',
      wiki: 'wiki/cast/aiko.md',
      assets: [
        {
          hash: 'a'.repeat(64),
          ext: 'png',
          kind: 'portrait',
          label: 'aaaaaaaa.png',
          accepted: true,
          base: true,
        },
      ],
      scenes: ['arrival'],
      shots: [{ scene: 'arrival', shot: 'arrival-s1' }],
    });
  });

  it('name a wiki link only when the sheet is actually filed there', () => {
    expect(backlinks['location:gate']!.sheet).toBe('locations/gate.md');
    expect(backlinks['location:gate']!.wiki).toBeUndefined();
    expect(backlinks['location:gate']!.scenes).toEqual(['arrival', 'orphan']);
  });

  it('are keyed by the same id the tree node carries', () => {
    const characters = branch(buildDocTree(makeInput()).roots, 'branch:characters').children!;
    expect(Object.keys(backlinks)).toContain(characters[0]!.id);
  });

  // A scene is a subject too — the frames drawn from it are what a pane showing its prose puts
  // underneath, and the shot each one illustrates travels with it so they can be gathered by it.
  it('join a scene to the frames drawn from it, naming the shot each one is for', () => {
    expect(backlinks['scene:arrival']).toEqual({
      sheet: 'scenes/arrival.md',
      assets: [
        {
          hash: 'b'.repeat(64),
          ext: 'png',
          kind: 'shot_image',
          label: 'bbbbbbbb.png',
          accepted: false,
          base: false,
          shotId: 'arrival-s1',
        },
      ],
      scenes: ['arrival'],
      shots: [{ scene: 'arrival', shot: 'arrival-s1' }],
    });
    expect(backlinks['scene:orphan']!.assets).toEqual([]);
  });
});

describe('pathIndex', () => {
  const { pathIndex } = buildDocTree(makeInput());

  it('turns the path a pane holds into the key the backlinks are under', () => {
    expect(pathIndex['wiki/cast/aiko.md']).toBe('character:aiko');
    expect(pathIndex['locations/gate.md']).toBe('location:gate');
    expect(pathIndex['scenes/arrival.md']).toBe('scene:arrival');
  });

  // The honest empty answer: no asset binds to a lore note, so it is in neither map and the pane
  // showing it says as much rather than drawing somebody else's art.
  it('leaves a lore note out, it being nothing’s subject', () => {
    expect(pathIndex['wiki/history/canal.md']).toBeUndefined();
    expect(Object.keys(buildDocTree(makeInput()).backlinks)).not.toContain('wiki:history/canal.md');
  });
});

describe('fileTree', () => {
  it('nests a flat path list, directories first, each carrying its own path', () => {
    const roots = fileTree(['scenes/b.md', 'scenes/a.md', 'project.yaml']);
    expect(roots.map((n) => n.id)).toEqual(['dir:scenes', 'file:project.yaml']);
    expect(roots[0]!.path).toBe('scenes');
    expect(roots[0]!.children!.map((n) => n.label)).toEqual(['a.md', 'b.md']);
  });

  it('caps each level, counting what it dropped', () => {
    const roots = fileTree(
      Array.from({ length: 4 }, (_, i) => `d/f${i}.md`),
      2,
    );
    expect(roots[0]!.children!.map((n) => n.label)).toEqual(['f0.md', 'f1.md', '… and 2 more']);
  });
});

describe('WorkspaceSession — the tree over a real project', () => {
  let p: TestProject;

  beforeAll(async () => {
    p = await makeProject({
      title: 'Tree',
      script: SCRIPTS.linear,
      files: { 'wiki/history/canal.md': '# The canal\n\nRaised over a filled canal.\n' },
    });
  });

  afterAll(async () => {
    await p.cleanup();
  });

  it('reads the authored project into branches, before anything is generated', async () => {
    const tree = await new WorkspaceSession(p.dir, true, deps).docTree();
    const scenes = branch(tree.roots, 'branch:story').children!;
    expect(scenes.map((s) => s.id)).toEqual(['scene:arrival', 'scene:rooftop']);
    expect(scenes.every((s) => s.path?.startsWith('scenes/'))).toBe(true);

    expect(branch(tree.roots, 'branch:characters').children!.map((c) => c.id)).toEqual([
      'character:aiko',
    ]);
    expect(branch(tree.roots, 'branch:wiki').children!.map((n) => n.id)).toEqual([
      'wikidir:history',
    ]);
    expect(branch(tree.roots, 'branch:assets').children).toEqual([]);
    expect(tree.backlinks['character:aiko']!.scenes.length).toBeGreaterThan(0);
  });

  it('binds generated art to the character it was made for', async () => {
    await p.run();
    const tree = await new WorkspaceSession(p.dir, true, deps).docTree();
    const portraits = tree.backlinks['character:aiko']!.assets;
    expect(portraits.length).toBeGreaterThan(0);
    expect(portraits.every((a) => a.kind === 'portrait' && a.base)).toBe(true);
  });

  it('walks the workspace on disk, skipping .git', async () => {
    const roots = await new WorkspaceSession(p.dir, true, deps).fileTree();
    expect(roots.map((n) => n.label)).toContain('project.yaml');
    expect(roots.map((n) => n.label)).not.toContain('.git');
    expect(roots.find((n) => n.id === 'dir:scenes')!.children!.map((n) => n.label)).toEqual([
      'arrival.md',
      'rooftop.md',
    ]);
  });
});
