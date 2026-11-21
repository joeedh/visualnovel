/**
 * The P3 gate as the solver's unit gate (stage 6c of
 * `docs/plans/archive/contracts-into-code-and-workflows.md`): a scene waits on the portraits of its
 * whole cast before it is decomposed or any of its shots is planned, the gate reads the manifest
 * row the way `approvedPortraitOf` does, and `gateStatus` answers what the live-scene walk it
 * replaced answered.
 */
import type { AnyTask, Asset, Character, ProjectModel } from '@vn/types';
import { pins } from '@vn/contracts';
import { TaskGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { solve, unitGates } from '@vn/constraint-solver';
import { approvedPortraitOf, gatePerUnit, stillsFamily } from '@vn/stills';
import { character, location, makeProject, model, scene, SCRIPTS, LISTED_ORDER } from '@vn/testkit';
import type { ScriptName } from '@vn/testkit';
import { gateStatus, planTasks, waveFacts, type GateStatus } from '../index.js';
import { config, FIXTURES, ROWS } from './__fixtures__/projects.js';

const AIKO = 'a'.repeat(64);
const REN = 'e'.repeat(64);

/** Aiko approved, Ren a draft, and a scene casting both that no storyboard covers yet. */
function cast(): ProjectModel {
  return model(
    [character('aiko', 'approved', AIKO), character('ren')],
    [scene('held', ['aiko', 'ren']), scene('open', ['aiko'])],
    [location('classroom')],
  );
}

/** Plans `n` waves, completing every pending task between them, and answers every wave's tasks. */
async function waves(
  m: ProjectModel,
  n: number,
  assets?: readonly Asset[],
  graph = new TaskGraph(),
): Promise<AnyTask[]> {
  const providers = createMockProviders();
  const out: AnyTask[] = [];
  for (let wave = 0; wave < n; wave++) {
    out.push(
      ...(await planTasks({ model: m, graph, config, providers, ...(assets ? { assets } : {}) })),
    );
    for (const t of graph.all())
      if (t.status === 'pending') graph.setStatus(t.hash, 'done', { output: `out-${t.hash}` });
  }
  return out;
}

/** The shot tasks among `tasks` that draw one of the scene's shots, whose ids carry the scene's. */
const shotsOfScene = (tasks: readonly AnyTask[], sceneId: string): AnyTask[] =>
  tasks.filter((t) => 'shotId' in t.inputs && t.inputs.shotId.startsWith(`${sceneId}__`));

const portrait = (hash: string, characterId: string, over: Partial<Asset> = {}): Asset => ({
  hash,
  ext       : 'png',
  kind      : 'portrait',
  sourceTask: `task-${hash.slice(0, 4)}`,
  refs      : [],
  modelId   : 'm',
  satisfies : [{ characterId }],
  accepted  : false,
  ...over,
});

/** The gate as `gateStatus` answered it before the solver did: a walk over live scenes' casts. */
function walked(m: ProjectModel, assets?: readonly Asset[]): GateStatus {
  const used = new Set<string>();
  for (const s of m.scenes.values())
    if (m.narrative.live(s.id)) for (const id of s.characters) used.add(id);
  const pending: string[] = [];
  const approved: string[] = [];
  for (const id of used) {
    const c: Character | undefined = m.characters.get(id);
    if (c && approvedPortraitOf(c, assets) !== undefined) approved.push(id);
    else pending.push(id);
  }
  return { pending: pending.sort(), approved: approved.sort(), cleared: pending.length === 0 };
}

describe(pins(gatePerUnit), () => {
  describe('a scene whose cast includes an unapproved character no shot shows', () => {
    it('is neither decomposed nor planned until that character is approved', async () => {
      const m = cast();
      const before = await waves(m, 4);
      expect(m.production.has('held')).toBe(false);
      expect(m.production.has('open')).toBe(true);
      expect(shotsOfScene(before, 'held')).toEqual([]);
      expect(shotsOfScene(before, 'open').length).toBeGreaterThan(0);

      Object.assign(m.characters.get('ren')!, { status: 'approved', approvedPortrait: REN });
      const after = await waves(m, 4);
      expect(m.production.has('held')).toBe(true);
      expect(shotsOfScene(after, 'held').length).toBeGreaterThan(0);
    });

    it('keeps an already decomposed scene’s shots unplanned, though they resolve', async () => {
      const fixture = FIXTURES['a gate held by a non-subject']!;
      for (const assets of [undefined, ROWS]) {
        const tasks = await waves(fixture.build(), 5, assets);
        expect(shotsOfScene(tasks, 'held')).toEqual([]);
        expect(shotsOfScene(tasks, 'open').length).toBeGreaterThan(0);
      }

      // With the plate drawn the held shot has an identity, and the gate alone holds it back
      const m = fixture.build();
      const graph = new TaskGraph();
      await waves(m, 3, ROWS, graph);
      const solved = solve(
        stillsFamily,
        waveFacts({ model: m, config, assets: ROWS, tasks: graph }),
      );
      expect(solved.units.get('held')).toEqual({
        gates  : ['portrait:aiko', 'portrait:ren'],
        holding: ['portrait:ren'],
        open   : false,
      });
      expect(solved.units.get('open')!.open).toBe(true);
      const held = solved.slots.get('shot:held/held__1')!;
      expect(held.taskHash).toBeDefined();
      expect(held.ready).toBe(false);
      expect(solved.slots.get('shot:open/open__1')!.ready).toBe(true);
    });
  });

  describe('reads the manifest row, by the gate’s own test', () => {
    const one = (): ProjectModel =>
      model([character('aiko')], [scene('room', ['aiko'])], [location('classroom')]);
    const open = (m: ProjectModel, assets?: readonly Asset[]): boolean =>
      unitGates(stillsFamily, waveFacts({ model: m, config, ...(assets ? { assets } : {}) })).get(
        'room',
      )!.open;

    it('opens on a row that is both current and accepted, and on nothing less', () => {
      expect(open(one(), [portrait(AIKO, 'aiko', { current: true })])).toBe(false);
      expect(open(one(), [portrait(AIKO, 'aiko', { current: true, accepted: true })])).toBe(true);
    });

    it('stays shut on an only row that is accepted but not current, which the slot calls approved', () => {
      const m = one();
      const assets = [portrait(AIKO, 'aiko', { accepted: true })];
      const facts = waveFacts({ model: m, config, assets });
      expect(solve(stillsFamily, facts).slots.get('portrait:aiko')!.approved).toBe(true);
      expect(open(m, assets)).toBe(false);
    });

    it('reads the sheet’s mirror without a manifest, and a lock whatever the slot holds', () => {
      const m = one();
      Object.assign(m.characters.get('aiko')!, { status: 'approved', approvedPortrait: AIKO });
      expect(open(m)).toBe(true);
      expect(open(m, [])).toBe(false);
      Object.assign(m.characters.get('aiko')!, { status: 'locked' });
      expect(open(m, [])).toBe(true);
    });

    it('is held by a cast member with no character sheet', () => {
      const m = model([], [scene('room', ['ghost'])], [location('classroom')]);
      expect(open(m)).toBe(false);
      expect(gateStatus(m).pending).toEqual(['ghost']);
    });
  });

  describe('gateStatus answers what the live-scene walk answered', () => {
    for (const [name, fixture] of Object.entries(FIXTURES)) {
      it(name, () => {
        for (const assets of [undefined, ROWS, []]) {
          const m = fixture.build();
          expect(gateStatus(m, assets)).toEqual(walked(m, assets));
        }
      });
    }

    it('with a scene left out of the story and a character no scene casts', () => {
      const m = cast();
      m.characters.set('uncast', character('uncast'));
      m.scenes.set('cut', scene('cut', ['uncast']));
      expect(gateStatus(m)).toEqual(walked(m));
      expect(gateStatus(m).pending).toEqual(['ren']);
    });

    for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
      it(`${name}, from nothing drawn to everything accepted`, async () => {
        const p = await makeProject({
          script: SCRIPTS[name],
          ...(name === 'listed'
            ? { config: { narrative: 'linear', scenes: [...LISTED_ORDER] } }
            : {}),
        });
        try {
          const agree = async (): Promise<void> => {
            const { model: m, store } = await p.reload();
            for (const assets of [store.manifest(), undefined])
              expect(gateStatus(m, assets)).toEqual(walked(m, assets));
          };
          await agree();
          await p.run();
          await agree();
          await p.approveAll();
          await agree();
          await p.run();
          await p.acceptAll();
          await agree();
        } finally {
          await p.cleanup();
        }
      }, 120_000);
    }
  });
});
