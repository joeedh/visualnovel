import type { DefectReport, Providers, Task } from '@vn/types';
import { createMockProviders, StubImageBackend } from '@vn/providers';
import { loadGraph, logTask, makeTask } from '@vn/taskgraph';
import { makeProject, SCRIPTS, type TestProject } from '@vn/testkit';
import { rm } from 'node:fs/promises';
import { GenDerivedPrompt, GenImage, GenOutput, Graph, registerGenRuntimes } from '@vn/gengraph';
import { runPipeline } from '../scheduler.js';

registerGenRuntimes();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function prepared(): Promise<{ p: TestProject; task: Task; providers: Providers }> {
  const p = await makeProject({
    script: SCRIPTS.linear,
    config: { concurrency: 1, max_refine_attempts: 3 },
  });
  await p.run();
  await p.approveAll();
  await p.run();
  const { graph, store } = await p.reload();
  const task = graph.all().find((t) => t.kind === 'shot_image')!;
  task.status = 'pending';
  delete task.output;
  await logTask(p.paths, task);
  const providers = createMockProviders({
    refLoader: async (ref) => ({ bytes: await store.read(ref), ext: ref.ext }),
  });
  return { p, task, providers };
}

const clean: DefectReport = { reviewer: 'test', defects: [] };
const blocked: DefectReport = {
  reviewer: 'test',
  defects: [
    {
      severity    : 'blocking',
      category    : 'pose',
      description : 'wrong pose',
      suggestedFix: 'Stand upright.',
    },
  ],
};

describe('request-boundary stopping', () => {
  it('finishes local bookkeeping when the task has no API requests left', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, config: { concurrency: 1 } });
    const stop = new AbortController();
    const backend = new StubImageBackend();
    const generate = backend.generate.bind(backend);
    const drawing = jest.spyOn(backend, 'generate').mockImplementation(async (...args) => {
      const answer = await generate(...args);
      stop.abort();
      return answer;
    });
    try {
      const summary = await p.run({ imageBackend: backend, signal: stop.signal });
      expect(summary.stopped).toBe(true);
      expect(drawing).toHaveBeenCalledTimes(1);
      expect(summary.ran).toHaveLength(1);
      expect(summary.ran[0]!.status).toBe('done');
      expect(summary.ran[0]!.checkpoint).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  });

  it('retains a planning response without persisting a stopped decomposition or fallback', async () => {
    const { p, providers } = await prepared();
    const stop = new AbortController();
    const entered = deferred();
    const release = deferred();
    try {
      const { model } = await p.reload();
      const scene = model.scenes.get('arrival')!;
      const payload = JSON.stringify({
        shots: [
          {
            id         : 'resumed',
            framing    : 'establishing',
            location   : 'day',
            coversLines: scene.lines.map((l) => l.id),
          },
        ],
      });
      const complete = jest.fn(async () => {
        entered.resolve();
        await release.promise;
        return JSON.parse(payload) as unknown;
      });
      providers.text.structured = async <T>(_prompt: string, parse: (raw: string) => T) => {
        const answer = await complete();
        return parse(JSON.stringify(answer));
      };
      await rm(p.paths.shotsFile('arrival'));
      const running = p.run({ providers, signal: stop.signal });
      await entered.promise;
      stop.abort();
      release.resolve();
      expect((await running).stopped).toBe(true);
      await expect(p.read('vngen/work/shots/arrival.json')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await p.run({ providers, only: [] });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await p.read('vngen/work/shots/arrival.json')).shots[0].id).toBe(
        'arrival__resumed',
      );
    } finally {
      release.resolve();
      await p.cleanup();
    }
  });

  it('saves an in-flight image, stops before review, and resumes it from disk', async () => {
    const { p, task, providers } = await prepared();
    const entered = deferred();
    const release = deferred();
    const stop = new AbortController();
    const generate = providers.image.generate.bind(providers.image);
    const drawing = jest.fn(async (...args: Parameters<typeof generate>) => {
      const result = await generate(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    providers.image.generate = drawing;
    const review = jest.fn(async () => clean);
    providers.reviewers = [{ id: 'test', review }];
    try {
      const running = p.run({ providers, only: [task.hash], signal: stop.signal });
      await entered.promise;
      stop.abort();
      release.resolve();
      const summary = await running;
      expect(summary.stopped).toBe(true);
      expect(summary.failed).toHaveLength(0);
      expect(review).not.toHaveBeenCalled();
      const saved = (await loadGraph(p.paths)).get(task.hash)!;
      expect(saved).toMatchObject({ status: 'pending', interrupted: true });
      expect(saved.checkpoint).toBeDefined();

      await p.run({ providers, only: [task.hash] });
      expect(drawing).toHaveBeenCalledTimes(1);
      expect(review).toHaveBeenCalledTimes(1);
      const resumed = (await loadGraph(p.paths)).get(task.hash)!;
      expect(resumed.status).toBe('done');
      expect(resumed.attempts).toHaveLength(task.attempts.length + 1);
      expect(resumed.checkpoint).toBeUndefined();
    } finally {
      release.resolve();
      await p.cleanup();
    }
  });

  it('drains parallel reviews and resumes refinement without repeating either review', async () => {
    const { p, task, providers } = await prepared();
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const stop = new AbortController();
    const generate = jest.fn(providers.image.generate.bind(providers.image));
    providers.image.generate = generate;
    const reviews = entered.map((start, i) =>
      jest.fn(async () => {
        start.resolve();
        await release[i]!.promise;
        return i === 0 ? blocked : clean;
      }),
    );
    providers.reviewers = reviews.map((review, i) => ({ id: `review-${i}`, review }));
    try {
      let finished = false;
      const running = p
        .run({
          providers,
          only  : [task.hash],
          signal: stop.signal,
          now   : () => '2026-01-01T00:00:00Z',
        })
        .then((s) => {
          finished = true;
          return s;
        });
      await Promise.all(entered.map((d) => d.promise));
      stop.abort();
      release[0]!.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      release[1]!.resolve();
      const summary = await running;
      expect(summary.stopped).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      expect((await loadGraph(p.paths)).get(task.hash)!.attempts).toHaveLength(
        task.attempts.length + 1,
      );

      reviews[0]!.mockImplementation(async () => clean);
      await p.run({ providers, only: [task.hash] });
      expect(generate).toHaveBeenCalledTimes(2);
      for (const review of reviews) expect(review).toHaveBeenCalledTimes(2);
      const resumed = (await loadGraph(p.paths)).get(task.hash)!;
      expect(resumed.status).toBe('done');
      expect(resumed.attempts).toHaveLength(task.attempts.length + 2);
      expect(resumed.attempts[task.attempts.length]!.at).toBe('2026-01-01T00:00:00Z');
    } finally {
      release.forEach((d) => d.resolve());
      await p.cleanup();
    }
  });

  it('resumes a bound generation graph without another image API call', async () => {
    const { p, task, providers } = await prepared();
    const graph = new Graph();
    const prompt = new GenDerivedPrompt();
    const image = new GenImage();
    const output = new GenOutput();
    graph.add(prompt);
    graph.add(image);
    graph.add(output);
    graph.connect(prompt.outputs.prompt, image.inputs.prompt);
    graph.connect(image.outputs.image, output.inputs.image);
    const shotId = (task.inputs as { shotId: string }).shotId;
    output.props.slot!.setValue(`shot:${shotId.split('__')[0]}/${shotId}`);
    const entered = deferred();
    const release = deferred();
    const stop = new AbortController();
    const backend = new StubImageBackend();
    const generate = backend.generate.bind(backend);
    const drawing = jest.spyOn(backend, 'generate').mockImplementation(async (...args) => {
      const answer = await generate(...args);
      entered.resolve();
      await release.promise;
      return answer;
    });
    const review = jest.fn(async () => clean);
    providers.reviewers = [{ id: 'test', review }];
    const options = {
      providers,
      only        : [task.hash],
      graphs      : { bound: graph },
      imageBackend: backend,
    };
    try {
      const running = p.run({ ...options, signal: stop.signal });
      await Promise.race([
        entered.promise,
        running.then((summary) => {
          throw new Error(`Run ended before drawing: ${JSON.stringify(summary)}`);
        }),
      ]);
      stop.abort();
      release.resolve();
      expect((await running).stopped).toBe(true);
      expect(review).not.toHaveBeenCalled();
      await p.run(options);
      expect(drawing).toHaveBeenCalledTimes(1);
      expect(review).toHaveBeenCalledTimes(1);
      expect((await loadGraph(p.paths)).get(task.hash)?.status).toBe('done');
    } finally {
      release.resolve();
      await p.cleanup();
    }
  });

  it('fences late answers after a hard abort', async () => {
    const { p, task, providers } = await prepared();
    const entered = deferred();
    const release = deferred();
    const settled = deferred();
    const abort = new AbortController();
    const generate = providers.image.generate.bind(providers.image);
    providers.image.generate = async (...args) => {
      const result = await generate(...args);
      entered.resolve();
      await release.promise;
      settled.resolve();
      return result;
    };
    const review = jest.fn(async () => clean);
    providers.reviewers = [{ id: 'test', review }];
    try {
      const running = p.run({ providers, only: [task.hash], abort: abort.signal });
      await entered.promise;
      abort.abort();
      await running;
      const before = await p.read('vngen/state/tasks.jsonl');
      const manifest = await p.read('vngen/build/manifest.json');
      release.resolve();
      await settled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(review).not.toHaveBeenCalled();
      expect(await p.read('vngen/state/tasks.jsonl')).toBe(before);
      expect(await p.read('vngen/build/manifest.json')).toBe(manifest);
    } finally {
      release.resolve();
      await p.cleanup();
    }
  });

  it('drains a slot write before a hard abort releases execution ownership', async () => {
    const { p, task, providers } = await prepared();
    const state = await p.reload();
    const entered = deferred();
    const release = deferred();
    const abort = new AbortController();
    const hold = state.store.hold.bind(state.store);
    jest.spyOn(state.store, 'hold').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return hold(...args);
    });
    providers.reviewers = [{ id: 'test', review: async () => clean }];
    try {
      let finished = false;
      const running = runPipeline({
        ...state,
        paths: p.paths,
        providers,
        only : [task.hash],
        abort: abort.signal,
      }).then((result) => {
        finished = true;
        return result;
      });
      await entered.promise;
      abort.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      release.resolve();
      expect((await running).stopped).toBe(true);
      expect((await loadGraph(p.paths)).get(task.hash)?.status).toBe('pending');
    } finally {
      release.resolve();
      await p.cleanup();
    }
  });

  it('keeps successful siblings across a failed review without erasing the failure budget', async () => {
    const { p, task, providers } = await prepared();
    const generate = jest.fn(providers.image.generate.bind(providers.image));
    providers.image.generate = generate;
    const first = jest.fn(async () => clean);
    const second = jest.fn(async (): Promise<DefectReport> => {
      throw new Error('review service unavailable');
    });
    providers.reviewers = [
      { id: 'first', review: first },
      { id: 'second', review: second },
    ];
    try {
      expect((await p.run({ providers, only: [task.hash] })).failed).toHaveLength(1);
      second.mockImplementation(async () => clean);
      await p.run({ providers, only: [task.hash] });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
      const after = (await loadGraph(p.paths)).get(task.hash)!;
      expect(after.status).toBe('done');
      expect(after.attempts.filter((a) => a.error)).toHaveLength(1);
      expect(after.attempts).toHaveLength(task.attempts.length + 2);
    } finally {
      await p.cleanup();
    }
  });

  it('never executes historical pending or abandoned tasks outside the current plan', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const params = { modelId: 'mock-image' };
      const old = makeTask('shot_image', {
        shotId: 'superseded',
        prompt: 'obsolete',
        refs  : [],
        params,
      });
      old.status = 'running';
      await logTask(p.paths, old);
      const pending = makeTask('shot_image', {
        shotId: 'orphan',
        prompt: 'obsolete',
        refs  : [],
        params,
      });
      await logTask(p.paths, pending);
      const backend = new StubImageBackend();
      const generate = jest.spyOn(backend, 'generate');
      await p.run({ imageBackend: backend });
      expect(generate.mock.calls.every(([prompt]) => prompt !== 'obsolete')).toBe(true);
      const after = await loadGraph(p.paths);
      expect(after.get(old.hash)).toMatchObject({ status: 'pending', interrupted: true });
      expect(after.get(pending.hash)?.status).toBe('pending');
    } finally {
      await p.cleanup();
    }
  });
});
