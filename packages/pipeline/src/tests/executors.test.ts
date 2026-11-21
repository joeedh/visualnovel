import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectConfig, WORKFLOWS, type AssetStore } from '@vn/types';
import { createMockProviders } from '@vn/providers';
import { ProjectPaths } from '@vn/store';
import { loadGraph } from '@vn/taskgraph';
import { stillsFamily } from '@vn/stills';
import { model } from '@vn/testkit';
import {
  EXECUTORS,
  costOf,
  costPreview,
  createRunners,
  familyOf,
  runTask,
  type RunDeps,
} from '../index.js';

const config = projectConfig.parse({
  title              : 'Test',
  max_refine_attempts: 3,
  models             : { vision: ['gemini', 'claude'] },
});

describe('the executor registry', () => {
  it("holds exactly the task kinds the registered workflows' families declare", () => {
    const declared = new Set(WORKFLOWS.flatMap((w) => familyOf(w).kinds.map((k) => k.task)));
    expect(familyOf('vn')).toBe(stillsFamily);
    expect(new Set(Object.keys(EXECUTORS))).toEqual(declared);
    expect(new Set(createRunners(config).keys())).toEqual(declared);
  });

  it('prices a shot at every refine attempt, each read by every reviewer', () => {
    expect(costOf('shot_image', config)).toEqual({ image: 3, review: 6 });
    expect(costOf('portrait', config)).toEqual({ image: 1, review: 0 });
  });
});

describe('a record of a kind no executor takes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vn-executors-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes `records` as the project's task log, one JSON line each. */
  async function writeLog(records: readonly object[]): Promise<ProjectPaths> {
    const paths = new ProjectPaths(dir);
    await mkdir(dirname(paths.tasksLog), { recursive: true });
    await writeFile(paths.tasksLog, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
    return paths;
  }

  const retired = [
    {
      hash    : 'review1',
      kind    : 'vision_review',
      deps    : [],
      inputs  : { target: 'a1', spec: 'a frame', refs: [], modelId: 'mock-text' },
      status  : 'pending',
      attempts: [],
    },
    {
      hash    : 'refine1',
      kind    : 'prompt_refine',
      deps    : [],
      inputs  : { basePrompt: 'p', defects: 'd', modelId: 'mock-text' },
      status  : 'pending',
      attempts: [],
    },
    {
      hash    : 'outfit1',
      kind    : 'outfit_sheet',
      deps    : [],
      inputs: {
        characterId: 'aiko',
        outfit     : 'default',
        angle      : 'front',
        prompt     : 'p',
        refs       : [],
        params     : { modelId: 'mock-image' },
      },
      status  : 'pending',
      attempts: [],
    },
  ];

  it('loads from an existing log, and fails when run, naming its kind', async () => {
    const graph = await loadGraph(await writeLog(retired));
    expect(graph.all().map((t) => t.kind)).toEqual([
      'vision_review',
      'prompt_refine',
      'outfit_sheet',
    ]);

    const deps: RunDeps = {
      model    : model([], [], []),
      store    : {} as AssetStore,
      providers: createMockProviders(),
      config,
    };
    const runners = createRunners(config);
    for (const task of graph.all()) {
      await expect(runTask(task, deps, runners)).resolves.toEqual({
        status: 'failed',
        error : `no runner for task kind "${task.kind}" (${task.hash})`,
      });
    }
  });

  it('is counted as pending work at the cost line it had', async () => {
    const preview = costPreview(await loadGraph(await writeLog(retired)), config);
    expect(preview.pendingTasks).toBe(3);
    expect(preview.imageCalls).toBe(1);
    expect(preview.reviewCalls).toBe(0);
  });
});
