/**
 * The stage 1 planner oracle (`docs/plans/contracts-into-code-and-workflows.md`): the live
 * planner and the frozen copy in `oracle.ts` must plan the same tasks, wave by wave, on fixtures
 * `prompthash.test.ts` does not reach, and both must keep the hashes pinned below.
 *
 * The pins were recorded from the planner as it stood on 2026-11-17, before any of the plan's
 * code moved. Re-recording them is never the fix for a failure here: a diff means a task's
 * identity moved, which re-renders that art in every existing project.
 */
import {
  projectConfig,
  type AnyTask,
  type Asset,
  type Character,
  type ProjectModel,
  type Scene,
  type Shot,
} from '@vn/types';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { character, location, model, scene } from '@vn/testkit';
import { planTasks } from '../index.js';
import { oraclePlanTasks } from './oracle.js';

const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'watercolor',
  models   : { vision: ['gemini', 'claude'] },
});

const PORTRAIT = 'a'.repeat(64);
const PIN = 'b'.repeat(64);

const frame = (sceneId: string, id: string, extra: Partial<Shot> = {}): Shot => ({
  id,
  sceneId,
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }],
  coversLines: [],
  ...extra,
});

/** A square panel at row `row` of a two-tier page. */
const tier = (row: number, framing: Shot['framing'], cast: string[]) => ({
  shape: [
    [0, row * 0.5],
    [1, row * 0.5],
    [1, row * 0.5 + 0.5],
    [0, row * 0.5 + 0.5],
  ] as [number, number][],
  framing,
  subjects   : cast.map((characterId) => ({ characterId })),
  coversLines: [],
});

const aiko = (): Character => character('aiko', 'approved', PORTRAIT);

/** A frame and a two-panel manga page in one scene. */
function manga(): ProjectModel {
  const room = scene('room', ['aiko'], 'classroom');
  room.shots = [
    frame('room', 'room__1'),
    frame('room', 'room__page1', {
      framing: 'wide',
      panels : [tier(0, 'wide', []), tier(1, 'close', ['aiko'])],
    }),
  ];
  return model([aiko()], [room], [location('classroom')]);
}

/** One group with no settings, one with a seed and notes, and a shot in neither. */
function sheets(): ProjectModel {
  const room = scene('room', ['aiko'], 'classroom');
  room.shots = [
    frame('room', 'room__1', { sheet: 'g1' }),
    frame('room', 'room__2', { sheet: 'g1' }),
    frame('room', 'room__3', { sheet: 'g2' }),
    frame('room', 'room__4', { sheet: 'g2', framing: 'close' }),
    frame('room', 'room__5'),
  ];
  room.sheets = { g2: { seed: 7, notes: 'the window stays on the left' } };
  return model([aiko()], [room], [location('classroom')]);
}

/**
 * A second outfit worn three ways: a scene's `[[outfit:]]`, a shot's own override back to the
 * default inside that scene, and a shot override in a scene that names none.
 */
function outfits(): ProjectModel {
  const c = aiko();
  c.defaultOutfit = 'uniform';
  c.outfits = [
    { id: 'uniform', characterId: 'aiko', description: 'school uniform' },
    { id: 'track', characterId: 'aiko', description: 'faded club tracksuit' },
  ];
  const cafe = location('cafe');
  cafe.variants = [
    { id: 'day', description: '' },
    { id: 'night', description: 'lamps on' },
  ];
  const s1: Scene = Object.assign(scene('s1', ['aiko'], 'cafe'), { outfits: { aiko: 'track' } });
  s1.shots = [
    frame('s1', 's1__1'),
    frame('s1', 's1__2', { subjects: [{ characterId: 'aiko', outfit: 'uniform' }] }),
  ];
  const s2 = scene('s2', ['aiko'], 'cafe');
  s2.shots = [
    frame('s2', 's2__1', { location: 'night' }),
    frame('s2', 's2__2', { subjects: [{ characterId: 'aiko', outfit: 'track' }] }),
  ];
  return model([c], [s1, s2], [cafe]);
}

/** References an author attached: on a shot's style clause, a portrait's and a plate's. */
function references(): ProjectModel {
  const c = aiko();
  c.promptOverride = { mode: 'chunks', refs: { style: [{ pin: PIN, ext: 'png' }] } };
  const room = location('classroom');
  room.variants[0]!.promptOverride = {
    mode: 'chunks',
    refs: { style: [{ pin: PIN, ext: 'png' }] },
  };
  const s = scene('room', ['aiko'], 'classroom');
  s.shots = [
    frame('room', 'room__1', {
      promptOverride: { mode: 'chunks', refs: { style: [{ pin: PIN, ext: 'png' }] } },
    }),
    frame('room', 'room__2'),
  ];
  return model([c], [s], [room]);
}

/** A scene whose cast includes someone no shot shows, still unapproved, beside one that clears. */
function gated(): ProjectModel {
  const held = scene('held', ['aiko', 'ren'], 'classroom');
  held.shots = [frame('held', 'held__1')];
  const open = scene('open', ['aiko'], 'classroom');
  open.shots = [frame('open', 'open__1')];
  return model([aiko(), character('ren')], [held, open], [location('classroom')]);
}

/** The portrait and plate rows a manifest-backed plan resolves a staging sheet's references from. */
const ROWS: Asset[] = [
  {
    hash      : PORTRAIT,
    ext       : 'png',
    kind      : 'portrait',
    sourceTask: 'task-portrait',
    refs      : [],
    modelId   : 'm',
    satisfies : [{ characterId: 'aiko' }],
    accepted  : true,
    current   : true,
  },
  {
    hash      : 'c'.repeat(64),
    ext       : 'png',
    kind      : 'location_ref',
    sourceTask: 'task-plate',
    refs      : [],
    modelId   : 'm',
    satisfies : [{ locationId: 'classroom', variant: 'day' }],
    accepted  : true,
    current   : true,
  },
];

type Planner = typeof planTasks;

interface Fixture {
  build: () => ProjectModel;
  assets?: readonly Asset[];
}

const FIXTURES: Record<string, Fixture> = {
  manga                         : { build: manga },
  'staging sheets'              : { build: sheets },
  'staging sheets, manifest'    : { build: sheets, assets: ROWS },
  outfits                       : { build: outfits },
  'authored references'         : { build: references },
  'a gate held by a non-subject': { build: gated },
};

/**
 * Plans to exhaustion the way the scheduler loops, completing every pending task between waves,
 * and answers each wave's planned tasks as sorted `kind hash` lines.
 */
async function waves(plan: Planner, fixture: Fixture): Promise<string[][]> {
  const graph = new TaskGraph();
  const m = fixture.build();
  const providers = createMockProviders();
  const out: string[][] = [];
  for (let wave = 0; wave < 5; wave++) {
    const planned = await plan({
      model: m,
      graph,
      config,
      providers,
      ...(fixture.assets ? { assets: fixture.assets } : {}),
    });
    out.push(planned.map((t) => `${t.kind} ${t.hash}`).sort());
    for (const t of graph.all()) {
      if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
    }
  }
  return out;
}

/** Every task any wave planned, as sorted `kind hash` lines. */
const PINNED: Record<string, string[]> = {
  manga: [
    'location_ref 8ddf6e606d6a1c6e26ae3b4b9d019513ae046911534078ab8823ea94685bca91',
    'model_sheet 36acf6d2f275c00edab6fdd1976a7a7897171116425b206140c56b8c2408cdf6',
    'model_sheet 89f5b88bf1d8f3e447131a6eeefec2e065b4836cc5db78f1b982084d8b686321',
    'model_sheet ab41d97135d9d865bec59de0f5f070f0aa4f1c8c9523d0859d4ddbbfe2a91f0a',
    'portrait 13ff6f08e60a098dd87411ef9854833961521499dd2e452259ca2e044f2cc59e',
    'shot_image 440dd0e4a65f33f6903a92786a719d92b002abd57c27f6b4a759ebb2a8f188dc',
    'shot_image 792df606f7e6da414bb9de1077d0eabd5a7e26417f87b03193f5e7252c630d1a',
  ],
  'staging sheets': [
    'location_ref 8ddf6e606d6a1c6e26ae3b4b9d019513ae046911534078ab8823ea94685bca91',
    'model_sheet 36acf6d2f275c00edab6fdd1976a7a7897171116425b206140c56b8c2408cdf6',
    'model_sheet 89f5b88bf1d8f3e447131a6eeefec2e065b4836cc5db78f1b982084d8b686321',
    'model_sheet ab41d97135d9d865bec59de0f5f070f0aa4f1c8c9523d0859d4ddbbfe2a91f0a',
    'portrait 13ff6f08e60a098dd87411ef9854833961521499dd2e452259ca2e044f2cc59e',
    'shot_image 0966427c5c4f3de4a81b182d554a8181de6fd4d57d79dd318622d222f41e59ab',
    'shot_image 5979780707407758fe7b03df7783c64c300b0613d1e174bd5eb43871d6d57030',
    'shot_image 5e139785e4a888df99efcabe48b60afc6d1bf7abb6626a86bc5d1d8cd2fa5a6e',
    'shot_image d9a46a119668a477962db003f241014a8352a6e0978833778d296d0acbbed4f6',
    'shot_image f0e7c40219c7be0a2866c20c061275946218fc18fe8b27679c9ba47624c26bad',
  ],
  'staging sheets, manifest': [
    'location_ref 8ddf6e606d6a1c6e26ae3b4b9d019513ae046911534078ab8823ea94685bca91',
    'model_sheet 36acf6d2f275c00edab6fdd1976a7a7897171116425b206140c56b8c2408cdf6',
    'model_sheet 89f5b88bf1d8f3e447131a6eeefec2e065b4836cc5db78f1b982084d8b686321',
    'model_sheet ab41d97135d9d865bec59de0f5f070f0aa4f1c8c9523d0859d4ddbbfe2a91f0a',
    'portrait 13ff6f08e60a098dd87411ef9854833961521499dd2e452259ca2e044f2cc59e',
    'shot_image 617f8f03d8c95c44e5a029c42c3dfb6b2e3ae22b76f74e3a96c95ec0d1b898fa',
    'shot_image b2ee59ebc85266baaab87f37c91a86ed38930cb292b142baf8b31d72258c9061',
    'shot_image bfaa0054d585324e7c3e9b24101b82074969c0103f3cf42024ac49a1f5ddd419',
    'shot_image c5e2f723b33b825b4614a2947e73cf7f0bfb58a6f108562651cb0a81ada6e91d',
    'shot_image d9a46a119668a477962db003f241014a8352a6e0978833778d296d0acbbed4f6',
  ],
  outfits: [
    'location_ref 008ba2bf380d43bc404c3f4db6b3f6fff2f576b7eda829cee25e3d1d4e69fbbf',
    'location_ref 9bc1339b622831b856e0955929e33111a3c3f23879458d3bb9f6a1ac5954f4d0',
    'model_sheet 32a2a3c2c64ab1bce822f03179d185419b5f8480dd175e268940981c66b6877b',
    'model_sheet 59e9c70f1b349804ec8f209759961fe152b718067ab87182838e65948c2e2f8c',
    'model_sheet 65392b618cd820e9e1027cc9d5d46ff1a52a7fee43ce5313f6ce17a94855f1a8',
    'model_sheet ca0fb023e02a63af1e6a354e9b3cf8422e4e50a490a2130b261969d41a37055a',
    'model_sheet ca4d9f03c9f7514b7244836fbdd4e9cb20f1cff6b02f026b03d48db99dfc9b9b',
    'model_sheet f22cdd4a9aad11f0fac1ac0c28a87378cd0424ae64deec2a6c39e90dc8bb51fc',
    'portrait 13ff6f08e60a098dd87411ef9854833961521499dd2e452259ca2e044f2cc59e',
    'shot_image 0353087eb9aa35d00b576665f02f08a44ac2847e47083951bb609b18cda78e55',
    'shot_image 460d40230be2fd8c1953b77811da384652cefbc34f761a072a649554be08a258',
    'shot_image 93bd1e14313623485078bda8be56856c6d6fe05e81e58d02c810f840b8e8f0c8',
    'shot_image e99b37fc604cbde29c675f92ae80df367a6ed9c9c153bb88cc7145c8f9ae6529',
  ],
  'authored references': [
    'location_ref 1944484c758efad2e7c470d3b21db4ee098234cdb4dcfc07030a188c1f988dae',
    'model_sheet 36acf6d2f275c00edab6fdd1976a7a7897171116425b206140c56b8c2408cdf6',
    'model_sheet 89f5b88bf1d8f3e447131a6eeefec2e065b4836cc5db78f1b982084d8b686321',
    'model_sheet ab41d97135d9d865bec59de0f5f070f0aa4f1c8c9523d0859d4ddbbfe2a91f0a',
    'portrait 46d3ee019c64a18cd8585e1bcf20ea92ea72181b96ef17a51aaefbcbdb2a39ab',
    'shot_image 7d6bbfb2bb4811dabf7221de4a955ac04167c16448557606840cec682daeac13',
    'shot_image ded020cf11a363e3c3e808af7e567163a29a530ad67d761e3aedaa75947c1b6f',
  ],
  'a gate held by a non-subject': [
    'location_ref 8ddf6e606d6a1c6e26ae3b4b9d019513ae046911534078ab8823ea94685bca91',
    'model_sheet 36acf6d2f275c00edab6fdd1976a7a7897171116425b206140c56b8c2408cdf6',
    'model_sheet 89f5b88bf1d8f3e447131a6eeefec2e065b4836cc5db78f1b982084d8b686321',
    'model_sheet ab41d97135d9d865bec59de0f5f070f0aa4f1c8c9523d0859d4ddbbfe2a91f0a',
    'portrait 13ff6f08e60a098dd87411ef9854833961521499dd2e452259ca2e044f2cc59e',
    'portrait 6f8e36d5249c6fea7285c2b93b4f32e87e63cd6dbf53219645c78f2efa22f6ad',
    'shot_image 2345a8d2687ef9ffbe7b6ab2e965b43e79a8615937f13b2327af64844bfc3b12',
  ],
};

const everyTask = (all: string[][]): string[] => [...new Set(all.flat())].sort();

describe('the planner oracle', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    describe(name, () => {
      it('plans what the oracle plans, wave by wave', async () => {
        expect(await waves(planTasks, fixture)).toEqual(await waves(oraclePlanTasks, fixture));
      });

      it('keeps every pinned task hash', async () => {
        const all = everyTask(await waves(planTasks, fixture));
        expect(all).toEqual(PINNED[name]);
      });
    });
  }

  // Each fixture has to reach the case it is named for, or its pins guard nothing
  it('reaches what each fixture is named for', async () => {
    const shots = async (fixture: Fixture): Promise<Map<string, AnyTask>> => {
      const graph = new TaskGraph();
      const m = fixture.build();
      for (let wave = 0; wave < 5; wave++) {
        await planTasks({
          model: m,
          graph,
          config,
          providers: createMockProviders(),
          ...(fixture.assets ? { assets: fixture.assets } : {}),
        });
        for (const t of graph.all()) {
          if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
        }
      }
      const out = new Map<string, AnyTask>();
      for (const t of graph.all()) if ('shotId' in t.inputs) out.set(t.inputs.shotId, t);
      return out;
    };
    const extra = (t: AnyTask | undefined): unknown =>
      (t?.inputs as { params?: { extra?: unknown } } | undefined)?.params?.extra;
    const refs = (t: AnyTask | undefined): string[] =>
      t && 'refs' in t.inputs ? t.inputs.refs.map((r) => r.hash) : [];

    const page = await shots(FIXTURES.manga!);
    expect((page.get('room__page1')!.inputs as { params: { aspect: string } }).params.aspect).toBe(
      config.image_params.page_aspect,
    );

    const grouped = await shots(FIXTURES['staging sheets']!);
    expect(extra(grouped.get('room__1'))).toHaveProperty('sheet');
    expect(extra(grouped.get('room__3'))).toHaveProperty('sheet');
    expect(extra(grouped.get('room__5'))).toBeUndefined();

    // A shot in a non-default outfit carries that outfit's front sheet as a second subject ref
    const dressed = await shots(FIXTURES.outfits!);
    expect(refs(dressed.get('s1__1'))).toHaveLength(3);
    expect(refs(dressed.get('s1__2'))).toHaveLength(2);
    expect(refs(dressed.get('s2__2'))).toHaveLength(3);

    const pinned = await shots(FIXTURES['authored references']!);
    expect(refs(pinned.get('room__1'))).toContain(PIN);
    expect(refs(pinned.get('room__2'))).not.toContain(PIN);

    const held = await shots(FIXTURES['a gate held by a non-subject']!);
    expect([...held.keys()]).toEqual(['open__1']);
  });
});
