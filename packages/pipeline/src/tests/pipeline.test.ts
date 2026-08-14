import { projectConfig, type Shot } from '@vn/types';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { character, location, model, scene } from '@vn/testkit';
import {
  baseRefusal,
  costPreview,
  decomposeScene,
  deterministicShots,
  gateStatus,
  buildPortraitPrompt,
  buildShotPrompt,
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

describe('buildShotPrompt — the outfit it says', () => {
  const shotOf = (subjects: Shot['subjects']): Shot => ({
    id: 's1__a',
    sceneId: 's1',
    framing: 'medium',
    location: 'day',
    subjects,
    coversLines: [],
    status: 'pending',
  });
  const build = (subjects: Shot['subjects'], sceneOutfits?: Record<string, string>): string => {
    const c = character('aiko', 'approved', 'h1');
    c.defaultOutfit = 'uniform';
    c.outfits = [
      { id: 'uniform', characterId: 'aiko', description: '' },
      { id: 'track', characterId: 'aiko', description: 'faded club tracksuit' },
    ];
    const s = scene('s1', ['aiko'], 'class');
    if (sceneOutfits) s.outfits = sceneOutfits;
    return buildShotPrompt(shotOf(subjects), s, model([c], [s], [location('class')]), config);
  };

  // The compatibility guarantee: a subject with no outfit produces the string P5 used to bake,
  // so nothing rehashes and nothing re-renders on this feature's account.
  it('resolves an unspecified outfit to the default, by the id it was baked as', () => {
    expect(build([{ characterId: 'aiko' }])).toContain('wearing uniform');
  });

  it('lets the scene marker through, and the shot override past it', () => {
    expect(build([{ characterId: 'aiko' }], { aiko: 'track' })).toContain(
      'wearing faded club tracksuit',
    );
    expect(build([{ characterId: 'aiko', outfit: 'uniform' }], { aiko: 'track' })).toContain(
      'wearing uniform',
    );
  });

  it('says the description an author wrote, in preference to the id', () => {
    expect(build([{ characterId: 'aiko', outfit: 'track' }])).toContain('faded club tracksuit');
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
    // No `outfit`: the decomposer casts the shot, it does not dress it.
    expect(deterministicShots(m.scenes.get('s1')!, m)[0]!.subjects).toEqual([
      { characterId: 'aiko' },
      { characterId: 'ben' },
    ]);
    expect(deterministicShots(m.scenes.get('s2')!, m)[0]!.subjects).toEqual([]);
  });

  it('binds coversLines to real line ids — narration to establishing, dialogue per character', () => {
    const s = scene('s1', ['aiko', 'ben'], 'class');
    s.lines = [
      { id: 's1:L1', kind: 'narration', text: 'The room is quiet.' },
      { id: 's1:L2', kind: 'dialogue', speaker: 'aiko', text: 'Hi.' },
      { id: 's1:L3', kind: 'dialogue', speaker: 'ben', text: 'Hey.' },
      { id: 's1:L4', kind: 'transition', text: 'CUT TO:' },
    ];
    const m = model(
      [character('aiko', 'approved', 'h1'), character('ben', 'approved', 'h2')],
      [s],
      [location('class')],
    );
    const shots = deterministicShots(m.scenes.get('s1')!, m);
    // Everything unattributed goes to the establishing shot, transitions included.
    expect(shots[0]!.coversLines).toEqual(['s1:L1', 's1:L4']);
    expect(shots[1]!.coversLines).toEqual(['s1:L2']); // aiko's dialogue
    expect(shots[2]!.coversLines).toEqual(['s1:L3']); // ben's dialogue
  });
});

describe('decomposeScene (LLM path)', () => {
  const build = () => {
    const s = scene('s1', ['aiko'], 'class');
    s.lines = [
      { id: 's1:L1', kind: 'narration', text: 'The room is quiet.' },
      { id: 's1:L2', kind: 'dialogue', speaker: 'aiko', text: 'Hi.' },
    ];
    return model([character('aiko', 'approved', 'h1')], [s], [location('class')]);
  };

  /** Mock providers whose text LLM answers with one canned decomposition. */
  const providersReturning = (shots: unknown[]) =>
    createMockProviders({ textResponses: [JSON.stringify({ shots })] });

  const SHOT = (id: string, coversLines: string[]) => ({
    id,
    framing: 'medium',
    location: 'day',
    subjects: [{ characterId: 'aiko', outfit: 'default' }],
    coversLines,
  });

  it('shows the model each line with its id, so coversLines is answerable at all', async () => {
    const m = build();
    const providers = providersReturning([SHOT('a', ['s1:L1', 's1:L2'])]);
    let seen = '';
    const inner = providers.text;
    providers.text = {
      complete: (p, s) => inner.complete(p, s),
      structured: (prompt, parse, system) => {
        seen = `${prompt}\n---\n${system}`;
        return inner.structured(prompt, parse, system);
      },
    };

    await decomposeScene(m.scenes.get('s1')!, m, providers);
    expect(seen).toContain('[s1:L1] narration: The room is quiet.');
    expect(seen).toContain('[s1:L2] dialogue/aiko: Hi.');
    // The template must not model an empty answer — that is what the LLM copied.
    expect(seen).not.toContain('"coversLines":[]');
  });

  it('keeps a decomposition that binds lines, dropping ids the scene does not have', async () => {
    const m = build();
    const shots = await decomposeScene(
      m.scenes.get('s1')!,
      m,
      providersReturning([SHOT('a', ['s1:L1']), SHOT('b', ['s1:L2', 's1:L9'])]),
    );
    expect(shots.map((s) => s.id)).toEqual([shotId('s1', 'a'), shotId('s1', 'b')]);
    expect(shots[1]!.coversLines).toEqual(['s1:L2']);
  });

  it('falls back to the baseline when the decomposition binds nothing', async () => {
    const m = build();
    // Every shot would be generated and none ever displayed — an unplayable scene, not a
    // stylistic difference, so the baseline is strictly better than honoring it.
    const shots = await decomposeScene(
      m.scenes.get('s1')!,
      m,
      providersReturning([SHOT('a', []), SHOT('b', ['s1:L9'])]),
    );
    expect(shots.map((s) => s.id)).toEqual([shotId('s1', 'establishing'), shotId('s1', 'beat1')]);
  });

  it('gives the first line to the first shot, so the scene cannot open on a blank frame', async () => {
    const m = build();
    const shots = await decomposeScene(
      m.scenes.get('s1')!,
      m,
      providersReturning([SHOT('a', []), SHOT('b', ['s1:L2'])]),
    );
    expect(shots[0]!.coversLines).toEqual(['s1:L1']);
    expect(shots[1]!.coversLines).toEqual(['s1:L2']);
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

/**
 * Sheets are three image calls each, so the planner fans them out over the outfits something
 * actually puts a character in — not over every one the sheet authors. And a shot in a non-default
 * outfit takes that outfit's front sheet as a reference, which makes it depend on that task.
 */
describe('planTasks (the outfits a run needs)', () => {
  const dressed = () => {
    const c = character('aiko', 'approved', 'portrait-hash');
    c.defaultOutfit = 'uniform';
    c.outfits = [
      { id: 'uniform', characterId: 'aiko', description: 'school uniform' },
      { id: 'track', characterId: 'aiko', description: 'faded club tracksuit' },
    ];
    return c;
  };

  const build = (marks?: Record<string, string>) => {
    const s = scene('s1', ['aiko'], 'class');
    if (marks) s.outfits = marks;
    return model([dressed()], [s], [location('class')]);
  };

  /** Plan, complete what was planned, plan again: the scheduler's loop with the models removed. */
  async function planWaves(m: ReturnType<typeof build>): Promise<TaskGraph> {
    const graph = new TaskGraph();
    const providers = createMockProviders();
    for (let wave = 0; wave < 3; wave++) {
      await planTasks({ model: m, graph, config, providers });
      for (const t of graph.all()) {
        if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
      }
    }
    return graph;
  }

  const sheets = (graph: TaskGraph): string[] =>
    graph
      .all()
      .filter((t) => t.kind === 'model_sheet')
      .map((t) => {
        const i = t.inputs as { outfit: string; angle: string };
        return `${i.outfit}/${i.angle}`;
      })
      .sort();

  const shots = (graph: TaskGraph) => graph.all().filter((t) => t.kind === 'shot_image');

  it('leaves an authored wardrobe nothing wears unplanned', async () => {
    // The compatibility half: writing down a second outfit costs nothing until it is used, so a
    // project that has never authored one plans exactly what it planned before this existed.
    expect(sheets(await planWaves(build()))).toEqual([
      'uniform/back',
      'uniform/front',
      'uniform/side',
    ]);
  });

  it('adds three sheets when a scene marker puts a character in a second outfit', async () => {
    expect(sheets(await planWaves(build({ aiko: 'track' })))).toEqual([
      'track/back',
      'track/front',
      'track/side',
      'uniform/back',
      'uniform/front',
      'uniform/side',
    ]);
  });

  it('re-hashes exactly the shots in the marked scene, and no others', async () => {
    const marked = model(
      [dressed()],
      [
        Object.assign(scene('s1', ['aiko'], 'class'), { outfits: { aiko: 'track' } }),
        scene('s2', ['aiko'], 'class'),
      ],
      [location('class')],
    );
    const plain = model(
      [dressed()],
      [scene('s1', ['aiko'], 'class'), scene('s2', ['aiko'], 'class')],
      [location('class')],
    );
    const hashOf = (graph: TaskGraph, sceneId: string) =>
      shots(graph)
        .filter((t) => (t.inputs as { shotId: string }).shotId.startsWith(`${sceneId}__`))
        .map((t) => t.hash)
        .sort();

    const a = await planWaves(marked);
    const b = await planWaves(plain);
    expect(hashOf(a, 's1')).not.toEqual(hashOf(b, 's1'));
    expect(hashOf(a, 's2')).toEqual(hashOf(b, 's2'));
    expect(hashOf(a, 's2').length).toBeGreaterThan(0);
  });

  it('makes a shot in a non-default outfit reference that outfit and wait for it', async () => {
    const graph = await planWaves(build({ aiko: 'track' }));
    const front = graph
      .all()
      .find(
        (t) =>
          (t.inputs as { outfit?: string; angle?: string }).outfit === 'track' &&
          (t.inputs as { angle?: string }).angle === 'front',
      )!;
    const shot = shots(graph)[0]!;
    expect(shot.deps).toContain(front.hash);
    expect((shot.inputs as { refs: { hash: string }[] }).refs.map((r) => r.hash)).toContain(
      front.output,
    );
  });

  it('does not reference a sheet for a subject wearing the default', async () => {
    const graph = await planWaves(build());
    const front = graph.all().find((t) => (t.inputs as { angle?: string }).angle === 'front')!;
    // The portrait already shows the default; a sheet ref would be a second picture of it, and
    // a dependency that delays every shot in the project by a wave.
    for (const shot of shots(graph)) expect(shot.deps).not.toContain(front.hash);
  });
});

describe('planTasks (unavailable base assets)', () => {
  const approved = () =>
    model(
      [character('aiko', 'approved', 'portrait-hash')],
      [scene('s1', ['aiko'], 'class')],
      [location('class')],
    );

  // The money case: a checkout without the base repo, where planning normally would regenerate
  // every portrait and model sheet the project already paid for.
  it('plans nothing at all, because every shot references base art too', async () => {
    const graph = new TaskGraph();
    await planTasks({
      model: approved(),
      graph,
      config,
      providers: createMockProviders(),
      base: { state: 'unavailable', root: '/p/assets', count: 0 },
    });
    expect(graph.all()).toEqual([]);
  });

  it('names the root and says restore, not regenerate', () => {
    const why = baseRefusal({ state: 'unavailable', root: '/p/assets', count: 0 });
    expect(why).toContain('/p/assets');
    expect(why).toContain('restore');
    // The other two states are not a refusal — `absent` is a brand-new or legacy project.
    expect(baseRefusal({ state: 'absent', root: '/p/assets', count: 0 })).toBeUndefined();
    expect(baseRefusal({ state: 'ready', root: '/p/assets', count: 4 })).toBeUndefined();
    expect(baseRefusal(undefined)).toBeUndefined();
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
