/**
 * The planner fixtures (`docs/reference/contracts.md`):
 * small in-memory projects that reach what `prompthash.test.ts` does not, shared by the planner's
 * pinned hashes and recorded waves and by the gate's tests.
 */
import {
  projectConfig,
  type Asset,
  type Character,
  type ProductionData,
  type ProjectModel,
  type Scene,
  type Shot,
} from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';

export const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'watercolor',
  models   : { vision: ['gemini', 'claude'] },
});

const PORTRAIT = 'a'.repeat(64);
export const PIN = 'b'.repeat(64);

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

/** `m` with each named scene's storyboard already in its production map. */
function staged(m: ProjectModel, boards: Record<string, ProductionData>): ProjectModel {
  for (const [id, board] of Object.entries(boards)) m.production.set(id, board);
  return m;
}

/** A frame and a two-panel manga page in one scene. */
function manga(): ProjectModel {
  const room = scene('room', ['aiko'], 'classroom');
  return staged(model([aiko()], [room], [location('classroom')]), {
    room: {
      shots: [
        frame('room', 'room__1'),
        frame('room', 'room__page1', {
          framing: 'wide',
          panels : [tier(0, 'wide', []), tier(1, 'close', ['aiko'])],
        }),
      ],
    },
  });
}

/** One group with no settings, one with a seed and notes, and a shot in neither. */
function sheets(): ProjectModel {
  const room = scene('room', ['aiko'], 'classroom');
  return staged(model([aiko()], [room], [location('classroom')]), {
    room: {
      shots: [
        frame('room', 'room__1', { sheet: 'g1' }),
        frame('room', 'room__2', { sheet: 'g1' }),
        frame('room', 'room__3', { sheet: 'g2' }),
        frame('room', 'room__4', { sheet: 'g2', framing: 'close' }),
        frame('room', 'room__5'),
      ],
      sheets: { g2: { seed: 7, notes: 'the window stays on the left' } },
    },
  });
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
  const s2 = scene('s2', ['aiko'], 'cafe');
  return staged(model([c], [s1, s2], [cafe]), {
    s1: {
      shots: [
        frame('s1', 's1__1'),
        frame('s1', 's1__2', { subjects: [{ characterId: 'aiko', outfit: 'uniform' }] }),
      ],
    },
    s2: {
      shots: [
        frame('s2', 's2__1', { location: 'night' }),
        frame('s2', 's2__2', { subjects: [{ characterId: 'aiko', outfit: 'track' }] }),
      ],
    },
  });
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
  return staged(model([c], [s], [room]), {
    room: {
      shots: [
        frame('room', 'room__1', {
          promptOverride: { mode: 'chunks', refs: { style: [{ pin: PIN, ext: 'png' }] } },
        }),
        frame('room', 'room__2'),
      ],
    },
  });
}

/** A scene whose cast includes someone no shot shows, still unapproved, beside one that clears. */
function gated(): ProjectModel {
  const held = scene('held', ['aiko', 'ren'], 'classroom');
  const open = scene('open', ['aiko'], 'classroom');
  return staged(model([aiko(), character('ren')], [held, open], [location('classroom')]), {
    held: { shots: [frame('held', 'held__1')] },
    open: { shots: [frame('open', 'open__1')] },
  });
}

/** The portrait and plate rows a manifest-backed plan resolves a staging sheet's references from. */
export const ROWS: Asset[] = [
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

export interface Fixture {
  build: () => ProjectModel;
  assets?: readonly Asset[];
}

export const FIXTURES: Record<string, Fixture> = {
  manga                         : { build: manga },
  'staging sheets'              : { build: sheets },
  'staging sheets, manifest'    : { build: sheets, assets: ROWS },
  outfits                       : { build: outfits },
  'authored references'         : { build: references },
  'a gate held by a non-subject': { build: gated },
};
