import { projectConfig } from '@vn/types';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { character, location, model, scene } from '@vn/testkit';
import {
  costPreview,
  deterministicShots,
  gateStatus,
  buildPortraitPrompt,
  planTasks,
  refinePrompt,
  shotId,
  shotSpec,
} from '../index.js';

const config = projectConfig.parse({
  title: 'Test',
  art_style: 'watercolor',
  models: { vision: ['gemini', 'claude'] },
});

describe('prompts', () => {
  it('folds art style and palette into a portrait prompt', () => {
    const prompt = buildPortraitPrompt(character('aiko', 'draft'), config);
    expect(prompt).toContain('watercolor');
    expect(prompt).toContain('AIKO');
    expect(prompt).toContain('#112233');
  });
});

describe('shotSpec', () => {
  const s = scene('s1', ['aiko'], 'class');
  s.synopsis = 'Aiko arrives and greets the player.';
  s.lines = [
    { id: 's1:L1', kind: 'narration', text: 'Rain streaks the windows.' },
    { id: 's1:L2', kind: 'dialogue', speaker: 'aiko', text: 'Hi.' },
  ];

  it('describes the shot, not the scene, and quotes only its own lines', () => {
    const spec = shotSpec(
      {
        id: 's1__b1',
        sceneId: 's1',
        framing: 'medium',
        location: 'day',
        subjects: [{ characterId: 'aiko', outfit: 'default' }],
        coversLines: ['s1:L2'],
        status: 'pending',
      },
      s,
    );
    expect(spec.description).not.toContain(s.synopsis!);
    expect(spec.description).toContain('medium shot set in day');
    expect(spec.description).toContain('must be in frame: aiko');
    expect(spec.description).toContain('aiko: Hi.');
    expect(spec.description).not.toContain('Rain streaks');
  });

  it('tells the reviewer a cast-less shot is a plate, so an absent character is not a defect', () => {
    const spec = shotSpec(
      {
        id: 's1__est',
        sceneId: 's1',
        framing: 'establishing',
        location: 'day',
        subjects: [],
        coversLines: ['s1:L1'],
        status: 'pending',
      },
      s,
    );
    expect(spec.characters).toEqual([]);
    expect(spec.description).toContain('background plate');
    expect(spec.description).toContain('not a defect');
    // The covered prose still travels, but explicitly demoted to context.
    expect(spec.description).toContain('for setting and mood only: Rain streaks the windows.');
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

  it('casts the establishing shot from the scene, and leaves a cast-less scene a bare plate', () => {
    const m = model(
      [character('aiko', 'approved', 'h1'), character('ben', 'approved', 'h2')],
      [scene('s1', ['aiko', 'ben'], 'class'), scene('s2', [], 'class')],
      [location('class')],
    );
    expect(deterministicShots(m.scenes.get('s1')!, m)[0]!.subjects).toEqual([
      { characterId: 'aiko', outfit: 'default' },
      { characterId: 'ben', outfit: 'default' },
    ]);
    expect(deterministicShots(m.scenes.get('s2')!, m)[0]!.subjects).toEqual([]);
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
