import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Character, Location, ProjectModel, Scene } from '@vn/types';
import { projectConfig } from '@vn/types';
import { AssetStore, ProjectPaths } from '@vn/store';
import { TaskGraph, loadGraph } from '@vn/taskgraph';
import { createMockProviders } from '@vn/providers';
import { runPipeline } from './index.js';

function character(id: string): Character {
  return {
    id,
    name: id.toUpperCase(),
    description: `${id} description`,
    traits: [],
    palette: [],
    referenceImages: [],
    status: 'draft',
    defaultOutfit: 'default',
    outfits: [{ id: 'default', characterId: id, description: 'default outfit' }],
  };
}

function makeModel(): ProjectModel {
  const aiko = character('aiko');
  const classroom: Location = {
    id: 'classroom',
    name: 'Classroom',
    description: 'A sunlit classroom.',
    palette: [],
    variants: [{ id: 'day', description: '' }],
    mined: false,
  };
  const s1: Scene = {
    id: 's1',
    location: 'classroom',
    characters: ['aiko'],
    body: 'Aiko enters and waves.',
    choices: [],
    shots: [],
  };
  return {
    title: 'Demo',
    characters: new Map([['aiko', aiko]]),
    locations: new Map([['classroom', classroom]]),
    scenes: new Map([['s1', s1]]),
    reachable: new Set(['s1']),
    entry: 's1',
    diagnostics: [],
  };
}

async function withProject<T>(fn: (paths: ProjectPaths, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'vngen-sched-'));
  try {
    return await fn(new ProjectPaths(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const cfg = (over: Record<string, unknown> = {}) =>
  projectConfig.parse({ title: 'Demo', models: { vision: ['gemini', 'claude'] }, ...over });

describe('runPipeline — gate-as-barrier end-to-end', () => {
  it('runs to the character gate, then continues after approval, producing assets', async () => {
    await withProject(async (paths) => {
      const model = makeModel();
      const config = cfg();
      const store = await AssetStore.open(paths);
      let graph = new TaskGraph();
      const providers = createMockProviders();

      // First run: locations + portraits only; halts at the approval gate.
      const first = await runPipeline({ model, graph, store, providers, config, paths });
      expect(first.blockedOnGate).toBe(true);
      expect(first.gate.pending).toEqual(['aiko']);
      expect(first.ran.some((t) => t.kind === 'location_ref' && t.status === 'done')).toBe(true);
      const portrait = first.ran.find((t) => t.kind === 'portrait');
      expect(portrait?.status).toBe('done');
      expect(first.ran.some((t) => t.kind === 'shot_image')).toBe(false);

      // The status log is replayable — done work is not repeated.
      graph = await loadGraph(paths);
      expect(graph.all().filter((t) => t.status === 'done').length).toBeGreaterThanOrEqual(2);

      // Approve the portrait (simulating `vngen approve`): flip the in-memory model.
      const aiko = model.characters.get('aiko')!;
      aiko.status = 'approved';
      aiko.approvedPortrait = portrait!.output;
      await store.accept(portrait!.output!);

      // Second run: model sheets + shots now plan and execute; gate clears.
      const second = await runPipeline({ model, graph, store, providers, config, paths });
      expect(second.gate.cleared).toBe(true);
      expect(second.blockedOnGate).toBe(false);
      expect(second.ran.some((t) => t.kind === 'model_sheet' && t.status === 'done')).toBe(true);
      const shots = second.ran.filter((t) => t.kind === 'shot_image');
      expect(shots.length).toBeGreaterThan(0);
      expect(shots.every((t) => t.status === 'done')).toBe(true);

      // The manifest records provenance for every produced asset.
      const kinds = new Set(store.manifest().map((a) => a.kind));
      expect(kinds.has('location_ref')).toBe(true);
      expect(kinds.has('portrait')).toBe(true);
      expect(kinds.has('shot_image')).toBe(true);
    });
  });

  it('caps the P7 loop and flags needs_human when reviewers keep blocking', async () => {
    await withProject(async (paths) => {
      const model = makeModel();
      const aiko = model.characters.get('aiko')!;
      aiko.status = 'approved';
      aiko.approvedPortrait = 'pre-approved-hash';

      const config = cfg({ max_refine_attempts: 2 });
      const store = await AssetStore.open(paths);
      const graph = new TaskGraph();
      const blocking =
        '{"reviewer":"x","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';
      const providers = createMockProviders({ reviewResponses: [blocking] });

      const summary = await runPipeline({ model, graph, store, providers, config, paths });
      const shots = summary.ran.filter((t) => t.kind === 'shot_image');
      expect(shots.length).toBeGreaterThan(0);
      const shot = shots[0]!;
      expect(shot.status).toBe('needs_human');
      // Capped at max_refine_attempts (2), each recorded for provenance.
      expect(shot.attempts).toHaveLength(2);
      expect(shot.attempts.every((a) => a.output)).toBe(true);
    });
  });

  it('dry-run previews cost without producing any assets', async () => {
    await withProject(async (paths) => {
      const model = makeModel();
      const store = await AssetStore.open(paths);
      const graph = new TaskGraph();
      const summary = await runPipeline({
        model,
        graph,
        store,
        providers: createMockProviders(),
        config: cfg(),
        paths,
        dryRun: true,
      });
      expect(summary.ran).toHaveLength(0);
      expect(summary.preview.pendingTasks).toBeGreaterThan(0);
      expect(store.manifest()).toHaveLength(0);
    });
  });
});
