/**
 * The planner, which plans from `solve(stillsFamily, facts)`, emits the waves recorded in
 * `__fixtures__/waves/`, which the stage 1 oracle produced on master before stage 6e
 * (`docs/plans/archive/contracts-into-code-and-workflows.md`). Each wave's tasks are compared with their
 * `deps`, and the shots the planner stamps are compared once the waves are over.
 *
 * The cases are the six stage 1 fixtures, three more that the planner and the slot graph once
 * answered differently, and every testkit script on disk before and after its cast is approved.
 */
import type { AnyTask, Asset, ProjectModel, Shot } from '@vn/types';
import { pins } from '@vn/contracts';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { character, location, makeProject, model, scene, SCRIPTS, LISTED_ORDER } from '@vn/testkit';
import type { ProjectPaths } from '@vn/store';
import type { ScriptName } from '@vn/testkit';
import { planTasks, planningIncremental } from '../index.js';
import { config, FIXTURES, type Fixture } from './__fixtures__/projects.js';
import fixtureWaves from './__fixtures__/waves/fixtures.json';
import branching from './__fixtures__/waves/branching.json';
import diamond from './__fixtures__/waves/diamond.json';
import linear from './__fixtures__/waves/linear.json';
import listed from './__fixtures__/waves/listed.json';
import orphan from './__fixtures__/waves/orphan.json';

type Planner = typeof planTasks;

/** What one planner did over a run of waves. */
interface Run {
  /** Each wave's tasks as sorted `kind hash deps` lines. */
  waves: string[][];
  /** What it stamped on every shot in the production map, by scene and shot id. */
  shots: Record<string, Pick<Shot, 'prompt' | 'image' | 'proseHash' | 'panelBoxes'>>;
}

/** The recorded waves of each script: before approval, after it, and after it with shots on disk. */
const SCRIPT_WAVES: Record<ScriptName, { before: Run; after: Run; drawn: Run }> = {
  branching,
  diamond,
  linear,
  listed,
  orphan,
};

const FIXTURE_WAVES: Record<string, Run> = fixtureWaves;

const line = (t: AnyTask): string => `${t.kind} ${t.hash} ${t.deps.join(',')}`;

/**
 * Plans five waves the way the scheduler loops, completing every pending task between them. A
 * shot's prompt is stamped only on a planned shot, so a shot no wave reached is compared too.
 */
async function waves(
  plan: Planner,
  m: ProjectModel,
  opts: { assets?: readonly Asset[]; paths?: ProjectPaths } = {},
): Promise<Run> {
  const graph = new TaskGraph();
  const providers = createMockProviders();
  const out: string[][] = [];
  for (let wave = 0; wave < 5; wave++) {
    const planned = await plan({
      model: m,
      graph,
      config,
      providers,
      ...(opts.assets ? { assets: opts.assets } : {}),
      ...(opts.paths ? { paths: opts.paths, readOnlyShots: true } : {}),
    });
    out.push(planned.map(line).sort());
    for (const t of graph.all()) {
      if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
    }
  }
  const shots: Run['shots'] = {};
  for (const [sceneId, board] of m.production)
    for (const s of board.shots)
      shots[`${sceneId}/${s.id}`] = {
        prompt    : s.prompt,
        image     : s.image,
        proseHash : s.proseHash,
        panelBoxes: s.panelBoxes,
      };
  return { waves: out, shots };
}

/** A location that declares no variants, which is planned a `day` plate. */
function bare(): ProjectModel {
  const roof = location('roof');
  roof.variants = [];
  const s = scene('top', ['aiko'], 'roof');
  const m = model([character('aiko', 'approved', 'a'.repeat(64))], [s], [roof]);
  m.production.set('top', {
    shots: [
      {
        id         : 'top__1',
        sceneId    : 'top',
        framing    : 'wide',
        location   : 'day',
        subjects   : [{ characterId: 'aiko' }],
        coversLines: [],
      },
    ],
  });
  return m;
}

/** A shot that puts its subject in an outfit the character sheet does not author. */
function unauthored(): ProjectModel {
  const s = scene('pool', ['aiko'], 'classroom');
  const m = model([character('aiko', 'approved', 'a'.repeat(64))], [s], [location('classroom')]);
  m.production.set('pool', {
    shots: [
      {
        id         : 'pool__1',
        sceneId    : 'pool',
        framing    : 'medium',
        location   : 'day',
        subjects   : [{ characterId: 'aiko', outfit: 'swim' }],
        coversLines: [],
      },
    ],
  });
  return m;
}

/** Two approved characters, cast in the reverse of the order the model holds them. */
function pair(): ProjectModel {
  const ren = character('ren', 'approved', 'r'.repeat(64));
  ren.outfits.push({ id: 'coat', characterId: 'ren', description: 'a long coat' });
  const s = Object.assign(scene('duo', ['ren', 'aiko'], 'classroom'), {
    outfits: { ren: 'coat' },
  });
  const m = model(
    [character('aiko', 'approved', 'a'.repeat(64)), ren],
    [s],
    [location('classroom')],
  );
  m.production.set('duo', {
    shots: [
      {
        id         : 'duo__1',
        sceneId    : 'duo',
        framing    : 'medium',
        location   : 'day',
        subjects   : [{ characterId: 'ren' }, { characterId: 'aiko' }],
        coversLines: [],
      },
    ],
  });
  return m;
}

const EXTRA: Record<string, Fixture> = {
  'a location with no variants'   : { build: bare },
  'an outfit only a shot names'   : { build: unauthored },
  'two characters cast in reverse': { build: pair },
};

describe(pins(planningIncremental), () => {
  describe('the planner plans the recorded tasks, wave by wave', () => {
    for (const [name, fixture] of Object.entries({ ...FIXTURES, ...EXTRA })) {
      it(name, async () => {
        const opts = fixture.assets ? { assets: fixture.assets } : {};
        const live = await waves(planTasks, fixture.build(), opts);
        expect(live).toEqual(FIXTURE_WAVES[name]);
        // Each case has to reach a shot, or it compared plates and portraits only
        expect(live.waves.flat().some((l) => l.startsWith('shot_image '))).toBe(true);
      });
    }
  });

  describe('over every testkit script on disk', () => {
    for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
      it(`${name}, before and after its cast is approved`, async () => {
        const p = await makeProject({
          script: SCRIPTS[name],
          ...(name === 'listed'
            ? { config: { narrative: 'linear', scenes: [...LISTED_ORDER] } }
            : {}),
        });
        try {
          const recorded = SCRIPT_WAVES[name];
          /** The planner over a fresh reload of the project as it stands, against `expected`. */
          const agree = async (withPaths: boolean, expected: Run): Promise<Run> => {
            const { model: m, store } = await p.reload();
            const run = await waves(planTasks, m, {
              assets: store.manifest(),
              ...(withPaths ? { paths: p.paths } : {}),
            });
            expect(run).toEqual(expected);
            return run;
          };

          await agree(false, recorded.before);
          await p.run();
          await p.approveAll();
          await p.run();
          await agree(false, recorded.after);
          const drawn = await agree(true, recorded.drawn);
          expect(drawn.waves.flat().some((l) => l.startsWith('shot_image '))).toBe(true);
        } finally {
          await p.cleanup();
        }
      }, 120_000);
    }
  });
});
