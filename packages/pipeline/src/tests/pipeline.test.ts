import type { Character, Location, ProjectModel, Scene } from '@vn/types';
import { projectConfig } from '@vn/types';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import {
  costPreview,
  deterministicShots,
  gateStatus,
  buildPortraitPrompt,
  planTasks,
  refinePrompt,
  shotId,
} from '../index.js';

const config = projectConfig.parse({
  title: 'Test',
  art_style: 'watercolor',
  models: { vision: ['gemini', 'claude'] },
});

function character(id: string, status: Character['status'], approvedPortrait?: string): Character {
  return {
    id,
    name: id.toUpperCase(),
    description: `${id} description`,
    traits: [],
    palette: ['#112233'],
    referenceImages: [],
    status,
    defaultOutfit: 'default',
    outfits: [{ id: 'default', characterId: id, description: 'default outfit' }],
    approvedPortrait,
  };
}

function location(id: string): Location {
  return {
    id,
    name: id,
    description: `${id} desc`,
    palette: [],
    variants: [{ id: 'day', description: '' }],
    mined: false,
  };
}

function scene(id: string, characters: string[], loc: string): Scene {
  return { id, location: loc, characters, body: 'They talk.', lines: [], choices: [], shots: [] };
}

function model(characters: Character[], scenes: Scene[], locations: Location[]): ProjectModel {
  return {
    title: 'Test',
    characters: new Map(characters.map((c) => [c.id, c])),
    locations: new Map(locations.map((l) => [l.id, l])),
    scenes: new Map(scenes.map((s) => [s.id, s])),
    reachable: new Set(scenes.map((s) => s.id)),
    entry: scenes[0]?.id,
    diagnostics: [],
  };
}

describe('prompts', () => {
  it('folds art style and palette into a portrait prompt', () => {
    const prompt = buildPortraitPrompt(character('aiko', 'draft'), config);
    expect(prompt).toContain('watercolor');
    expect(prompt).toContain('AIKO');
    expect(prompt).toContain('#112233');
  });
});

describe('refinePrompt', () => {
  it('appends corrections and does not accumulate across refines', () => {
    const once = refinePrompt('a shot', [
      {
        severity: 'blocking',
        category: 'outfit',
        description: 'wrong',
        suggestedFix: 'use blazer',
      },
    ]);
    expect(once).toContain('Corrections: use blazer');
    const twice = refinePrompt(once, [
      { severity: 'blocking', category: 'hair', description: 'too long' },
    ]);
    expect(twice).toContain('fix hair: too long');
    expect(twice).not.toContain('use blazer');
  });
});

describe('gateStatus', () => {
  it('only counts characters used by reachable scenes', () => {
    const m = model(
      [
        character('aiko', 'approved', 'h1'),
        character('ben', 'draft'),
        character('unused', 'draft'),
      ],
      [scene('s1', ['aiko', 'ben'], 'class')],
      [location('class')],
    );
    const gate = gateStatus(m);
    expect(gate.approved).toEqual(['aiko']);
    expect(gate.pending).toEqual(['ben']);
    expect(gate.cleared).toBe(false);
  });
});

describe('deterministicShots', () => {
  it('produces an establishing shot plus one per character', () => {
    const m = model(
      [character('aiko', 'approved', 'h1')],
      [scene('s1', ['aiko'], 'class')],
      [location('class')],
    );
    const shots = deterministicShots(m.scenes.get('s1')!, m);
    expect(shots).toHaveLength(2);
    expect(shots[0]!.framing).toBe('establishing');
    expect(shots[1]!.subjects[0]!.characterId).toBe('aiko');
    expect(shots[1]!.id).toBe(shotId('s1', 'beat1'));
  });

  it('binds coversLines to real line ids — narration to establishing, dialogue per character', () => {
    const s = scene('s1', ['aiko', 'ben'], 'class');
    s.lines = [
      { id: 's1:L1', kind: 'narration', text: 'The room is quiet.' },
      { id: 's1:L2', kind: 'dialogue', speaker: 'aiko', text: 'Hi.' },
      { id: 's1:L3', kind: 'dialogue', speaker: 'ben', text: 'Hey.' },
      { id: 's1:L4', kind: 'action', speaker: 'aiko', text: 'She waves.' },
    ];
    const m = model(
      [character('aiko', 'approved', 'h1'), character('ben', 'approved', 'h2')],
      [s],
      [location('class')],
    );
    const shots = deterministicShots(m.scenes.get('s1')!, m);
    // Establishing covers narration + non-attributed... here the action is attributed but still
    // narration/action-kinded, so both L1 and L4 land on the establishing shot.
    expect(shots[0]!.coversLines).toEqual(['s1:L1', 's1:L4']);
    expect(shots[1]!.coversLines).toEqual(['s1:L2']); // aiko's dialogue
    expect(shots[2]!.coversLines).toEqual(['s1:L3']); // ben's dialogue
  });
});

describe('planTasks (gate-as-barrier)', () => {
  it('plans locations + portraits but no shots until characters are approved', async () => {
    const m = model(
      [character('aiko', 'draft')],
      [scene('s1', ['aiko'], 'class')],
      [location('class')],
    );
    const graph = new TaskGraph();
    const providers = createMockProviders();
    await planTasks({ model: m, graph, config, providers });
    const kinds = graph
      .all()
      .map((t) => t.kind)
      .sort();
    expect(kinds).toContain('location_ref');
    expect(kinds).toContain('portrait');
    expect(kinds).not.toContain('shot_image');
    expect(kinds).not.toContain('model_sheet');
  });

  it('is idempotent — re-planning dedupes to the same task set', async () => {
    const m = model(
      [character('aiko', 'draft')],
      [scene('s1', ['aiko'], 'class')],
      [location('class')],
    );
    const graph = new TaskGraph();
    const providers = createMockProviders();
    await planTasks({ model: m, graph, config, providers });
    const n = graph.all().length;
    await planTasks({ model: m, graph, config, providers });
    expect(graph.all().length).toBe(n);
  });

  it('plans model sheets once a character is approved', async () => {
    const m = model(
      [character('aiko', 'approved', 'portrait-hash')],
      [scene('s1', ['aiko'], 'class')],
      [location('class')],
    );
    const graph = new TaskGraph();
    const providers = createMockProviders();
    await planTasks({ model: m, graph, config, providers });
    expect(graph.all().some((t) => t.kind === 'model_sheet')).toBe(true);
  });
});

describe('costPreview', () => {
  it('counts shot tasks at the P7 worst case (attempts × reviewers)', async () => {
    const m = model(
      [character('aiko', 'draft')],
      [scene('s1', ['aiko'], 'class')],
      [location('class')],
    );
    const graph = new TaskGraph();
    await planTasks({ model: m, graph, config, providers: createMockProviders() });
    const preview = costPreview(graph, config);
    // Only locations + portraits planned pre-gate, all single image calls, no reviews.
    expect(preview.reviewCalls).toBe(0);
    expect(preview.imageCalls).toBe(preview.byKind.location_ref + preview.byKind.portrait);
  });
});
