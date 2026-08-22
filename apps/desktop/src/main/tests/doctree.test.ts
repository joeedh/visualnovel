/**
 * The document tree is a projection, so most of it is testable with no filesystem at all — the
 * end-to-end case at the bottom is what proves the projection is fed the real thing.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { SlotGraph, SlotNode } from '@vn/artgen';
import type { Asset, ProjectModel, RefBinding, Shot } from '@vn/types';
import type { LoadedInputs } from '@vn/parse';
import type { DocNode } from '../../shared/ipc.js';
import {
  DEFAULT_CAP,
  buildDocTree,
  fileTree,
  type DocTreeInput,
  type SkillEntry,
} from '../doctree.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent: () => {},
  requestPlan: () => Promise.resolve({ approved: false }),
  requestAnswer: () => Promise.resolve([]),
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

/** A real skill on disk, front-matter and all — what `discoverSkills` actually reads. */
const SKILL_MD = `---
name: Continuity pass
description: List what a scene contradicts.
---

Read the scene twice, then the bible.
`;

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
    // A missing storyboard is different from an empty one, and different again from a file that
    // would not parse.
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
    // The cap limits what the tree draws at rest rather than what it knows, so the dropped rows
    // hang under the `more` node and stay one click away.
    expect(shots[2]!.children!.map((n) => n.label)).toEqual(['s2', 's3', 's4']);
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
    // A caller that has not built the graph must not appear to claim that nothing is waiting.
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
    // `a` is `accepted: true` and still waiting, because a portrait's approval comes from the P3
    // gate and from nothing else.
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
    // unrendered. Having no candidates is the predicate instead, which keeps the two groups
    // disjoint.
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

describe('the Skills branch', () => {
  const skill = (over: Partial<SkillEntry> = {}): SkillEntry => ({
    id: 'continuity-pass',
    name: 'Continuity pass',
    description: 'Re-read a scene against the bible and list what contradicts it.',
    file: '.aiagent/skills/continuity-pass/SKILL.md',
    script: false,
    ...over,
  });

  const skills = (entries: readonly SkillEntry[]): DocNode | undefined =>
    buildDocTree(makeInput({ skills: entries })).roots.find((n) => n.id === 'branch:skills');

  it('is absent when the caller did not look for skills', () => {
    expect(buildDocTree(makeInput()).roots.map((n) => n.id)).not.toContain('branch:skills');
  });

  // This is the one branch drawn empty. A skill has to be findable before one exists, so `[]` and
  // `undefined` are deliberately different answers.
  it('is drawn empty when the caller looked and found none', () => {
    expect(skills([])).toEqual({
      id: 'branch:skills',
      kind: 'branch',
      label: 'Skills',
      children: [],
    });
  });

  it('sits after Wiki and before the two lenses on the manifest', () => {
    // One slot waiting, so the Unapproved branch is drawn too — otherwise there is no second
    // root between Skills and Assets to be ordered against.
    const waiting: SlotNode = {
      key: 'portrait:aiko',
      binding: { kind: 'portrait', characterId: 'aiko' },
      label: 'portrait:aiko',
      refs: [],
      candidates: ['a'.repeat(64)],
      approved: false,
    };
    const graph: SlotGraph = {
      nodes: new Map([[waiting.key, waiting]]),
      dependents: new Map(),
      order: [waiting.key],
    };
    const roots = buildDocTree(makeInput({ skills: [], slots: graph })).roots;
    expect(roots.map((n) => n.id)).toEqual([
      'branch:story',
      'branch:characters',
      'branch:locations',
      'branch:wiki',
      'branch:skills',
      'branch:unapproved',
      'branch:assets',
    ]);
  });

  it('draws one leaf per skill: the name, the SKILL.md, and no children', () => {
    const [leaf] = skills([skill()])!.children!;
    expect(leaf).toEqual({
      id: 'skill:continuity-pass',
      kind: 'skill',
      label: 'Continuity pass',
      path: '.aiagent/skills/continuity-pass/SKILL.md',
      note: 'Re-read a scene against the bible and list what contradicts it.',
    });
    expect(leaf!.children).toBeUndefined();
  });

  it('badges the ones a person gave a script', () => {
    const children = skills([
      skill(),
      skill({ id: 'lint', name: 'Lint', script: true }),
    ])!.children!;
    expect(children.map((n) => n.badge)).toEqual([undefined, 'script']);
  });

  // Every row carries a tooltip, and a skill with no description is the row that most needs one.
  it('says what a skill is when it does not say so itself', () => {
    const [leaf] = skills([skill({ description: '' })])!.children!;
    expect(leaf!.note).toBe('A playbook the agent can follow. Open it in the Skills pane.');
  });

  it('caps the branch, counting what it dropped', () => {
    const many = Array.from({ length: 4 }, (_, i) => skill({ id: `s${i}`, name: `S${i}` }));
    const children = buildDocTree(makeInput({ skills: many, cap: 2 })).roots.find(
      (n) => n.id === 'branch:skills',
    )!.children!;
    expect(children.map((n) => n.label)).toEqual(['S0', 'S1', '… and 2 more']);
  });
});

/**
 * A project that re-rendered a portrait four times has four rows named `Aiko`, three of which
 * nobody will look at again. The slot graph already knows which one fills the slot, so the branch
 * asks it and draws one row per slot, with the earlier takes folded underneath. Nothing is
 * dropped, because deleting a take is a right-click on its own row.
 */
describe('the Assets branch, one row per slot', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const OLD = 'c'.repeat(64);

  const slot = (key: string, binding: RefBinding, over: Partial<SlotNode> = {}): SlotNode => ({
    key,
    binding,
    label: key,
    refs: [],
    candidates: [],
    approved: false,
    ...over,
  });

  const slots = (nodes: SlotNode[]): SlotGraph => ({
    nodes: new Map(nodes.map((n) => [n.key, n])),
    dependents: new Map(),
    order: nodes.map((n) => n.key),
  });

  /** The default manifest plus one older portrait take, and the slot that moved on from it. */
  const withOldTake = (over: Partial<SlotNode> = {}) => {
    const base = makeInput();
    const portrait = slot(
      'portrait:aiko',
      { kind: 'portrait', characterId: 'aiko' },
      {
        candidates: [HASH_A, OLD],
        hash: HASH_A,
        ...over,
      },
    );
    return buildDocTree({
      ...base,
      manifest: [...base.manifest, asset(OLD)],
      slots: slots([portrait]),
    });
  };

  const kinds = (tree: { roots: DocNode[] }) => branch(tree.roots, 'branch:assets').children!;

  it('folds an earlier take under the picture that replaced it, and counts rows', () => {
    const portraits = kinds(withOldTake())[0]!;
    // One row, because one slot. The heading counts the rows it draws, so two takes of one
    // portrait count once.
    expect(portraits.label).toBe('Portraits (1)');
    expect(portraits.children!.map((n) => n.id)).toEqual([`asset:${HASH_A}`]);

    const current = portraits.children![0]!;
    expect(current.children!.map((n) => n.id)).toEqual([`asset:${OLD}`]);
    // The row's note has to say that a second click opens the earlier takes, since nothing else
    // in the tree behaves this way.
    expect(current.note).toContain('click again to see history');
    expect(current.children![0]!.note).toContain('earlier take');
  });

  it('opens on the newest take where the slot could not choose between them', () => {
    // `pick` declines on a tie. Manifest order is the only record of when a picture was made, so
    // the row opens on the newest. That is not a verdict: both candidates are still listed one
    // per row in the Unapproved branch, where the choice is made.
    const portraits = kinds(withOldTake({ hash: undefined }))[0]!;
    expect(portraits.label).toBe('Portraits (1)');
    expect(portraits.children!.map((n) => n.id)).toEqual([`asset:${OLD}`]);
    expect(portraits.children![0]!.children!.map((n) => n.id)).toEqual([`asset:${HASH_A}`]);
  });

  it('files a picture two slots claim under the first of them', () => {
    // A sheet bound to two outfits is one render; drawing it twice would make the manifest look
    // twice the size it is, and `SlotGraph.order` is what decides which row gets it.
    const base = makeInput();
    const both = ['portrait:aiko', 'portrait:aiko-again'].map((key) =>
      slot(key, { kind: 'portrait', characterId: 'aiko' }, { candidates: [HASH_A], hash: HASH_A }),
    );
    const portraits = kinds(buildDocTree({ ...base, slots: slots(both) }))[0]!;
    expect(portraits.label).toBe('Portraits (1)');
    expect(portraits.children![0]!.note).toContain('portrait:aiko.');
  });

  it('keeps an asset no slot mentions, because silence is not a verdict', () => {
    // A concept is bound to what it sketches and never planned, so no slot ever names it.
    const base = makeInput();
    const sketch = asset(OLD, { kind: 'concept' });
    const tree = buildDocTree({
      ...base,
      manifest: [...base.manifest, sketch],
      slots: slots([
        slot('portrait:aiko', { kind: 'portrait', characterId: 'aiko' }, { candidates: [HASH_A] }),
      ]),
    });
    const concepts = kinds(tree).find((n) => n.id === 'assetkind:concept')!;
    expect(concepts.label).toBe('Concepts (1)');
    expect(concepts.children!.map((n) => n.id)).toEqual([`asset:${OLD}`]);
  });

  it('lists rows by name, with digit runs compared as numbers', () => {
    const base = makeInput();
    const hashes = ['d', 'e', 'f'].map((c) => c.repeat(64));
    const labels = new Map([
      [hashes[0]!, 'Shot 10'],
      [hashes[1]!, 'Shot 9'],
      [hashes[2]!, 'Aiko'],
    ]);
    // Handed over in `SlotGraph.order`, which here is not the order an author reads them in.
    const nodes = hashes.map((hash, i) =>
      slot(
        `portrait:s${i}`,
        { kind: 'portrait', characterId: 'aiko' },
        { candidates: [hash], hash },
      ),
    );
    const tree = buildDocTree({
      ...base,
      manifest: hashes.map((hash) => asset(hash)),
      assetLabels: labels,
      slots: slots(nodes),
    });
    expect(kinds(tree)[0]!.children!.map((n) => n.label)).toEqual(['Aiko', 'Shot 9', 'Shot 10']);
  });

  it('is a flat list of everything without a slot graph', () => {
    const plain = kinds(buildDocTree(makeInput()));
    expect(plain.map((n) => [n.label, n.children!.map((c) => c.id)])).toEqual([
      ['Portraits (1)', [`asset:${HASH_A}`]],
      ['Shot frames (1)', [`asset:${HASH_B}`]],
    ]);
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

  // A scene is a subject too. A pane showing its prose puts the frames drawn from it underneath,
  // and each frame carries the shot it illustrates so the frames can be grouped by shot.
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

  // No asset binds to a lore note, so it is in neither map, and the pane showing it says so
  // rather than drawing another subject's art.
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

  // A caller that walked one subdirectory still gets ids a click can act on. The prefix goes on
  // every id and path, while the structure comes from the paths as they arrived.
  it('prefixes ids and paths without changing the shape they nest into', () => {
    const roots = fileTree(['lint/run.mjs', 'lint/SKILL.md'], DEFAULT_CAP, '.aiagent/skills/');
    expect(roots.map((n) => n.id)).toEqual(['dir:.aiagent/skills/lint']);
    expect(roots[0]!.path).toBe('.aiagent/skills/lint');
    expect(roots[0]!.label).toBe('lint');
    expect(roots[0]!.children!.map((n) => n.id)).toEqual([
      'file:.aiagent/skills/lint/SKILL.md',
      'file:.aiagent/skills/lint/run.mjs',
    ]);
    expect(roots[0]!.children!.map((n) => n.path)).toEqual([
      '.aiagent/skills/lint/SKILL.md',
      '.aiagent/skills/lint/run.mjs',
    ]);
  });

  it('still puts directories before files under a prefix', () => {
    const roots = fileTree(['b.md', 'a/x.md'], DEFAULT_CAP, 'p/');
    expect(roots.map((n) => n.id)).toEqual(['dir:p/a', 'file:p/b.md']);
  });
});

describe('WorkspaceSession — the tree over a real project', () => {
  let p: TestProject;

  beforeAll(async () => {
    p = await makeProject({
      title: 'Tree',
      script: SCRIPTS.linear,
      files: {
        'wiki/history/canal.md': '# The canal\n\nRaised over a filled canal.\n',
        '.aiagent/skills/continuity-pass/SKILL.md': SKILL_MD,
      },
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

  // The pure projection cannot check this. `SkillEntry.file` is built by `relPath`, and on
  // Windows the path it starts from is backslash-separated; a backslash here would ship a path
  // `doc.read` refuses and no pane could open.
  it('finds the skills on disk, with a path a document command would take', async () => {
    const tree = await new WorkspaceSession(p.dir, true, deps).docTree();
    expect(branch(tree.roots, 'branch:skills').children).toEqual([
      {
        id: 'skill:continuity-pass',
        kind: 'skill',
        label: 'Continuity pass',
        path: '.aiagent/skills/continuity-pass/SKILL.md',
        note: 'List what a scene contradicts.',
      },
    ]);
  });

  it('binds generated art to the character it was made for', async () => {
    await p.run();
    const tree = await new WorkspaceSession(p.dir, true, deps).docTree();
    const portraits = tree.backlinks['character:aiko']!.assets;
    expect(portraits.length).toBeGreaterThan(0);
    expect(portraits.every((a) => a.kind === 'portrait' && a.base)).toBe(true);
  });

  it('walks the skills directory on its own, with workspace-relative ids', async () => {
    const roots = await new WorkspaceSession(p.dir, true, deps).skillTree();
    expect(roots.map((n) => n.id)).toEqual(['dir:.aiagent/skills/continuity-pass']);
    expect(roots[0]!.children!.map((n) => n.path)).toEqual([
      '.aiagent/skills/continuity-pass/SKILL.md',
    ]);
  });

  // Every project starts here — `skeleton()` writes no `.aiagent/` at all — so a missing
  // directory is the ordinary case and must be `[]` rather than the walk's rejection.
  it('answers with nothing at all where no skills directory exists', async () => {
    const bare = join(p.dir, 'empty-workspace');
    await mkdir(bare, { recursive: true });
    expect(await new WorkspaceSession(bare, true, deps).skillTree()).toEqual([]);
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
