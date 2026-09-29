import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyTask, ImageParams } from '@vn/types';
import { readJsonl } from '@vn/util';
import { ProjectPaths } from '@vn/store';
import { loadGraph, logTask, logTombstone, makeTask, TaskGraph } from '../index.js';

const params: ImageParams = { modelId: 'm' };

async function project(): Promise<{ paths: ProjectPaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'vn-tomb-'));
  return { paths: new ProjectPaths(root), cleanup: () => rm(root, { recursive: true }) };
}

/** A done portrait and the pending sheet that depends on it. */
function portraitAndSheet(): { portrait: AnyTask; sheet: AnyTask } {
  const portrait: AnyTask = {
    ...makeTask('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params }),
    status  : 'done',
    output  : 'asset1',
    attempts: [{ attempt: 1, refs: [], output: 'asset1' }],
  };
  const sheet = makeTask(
    'model_sheet',
    { characterId: 'aiko', outfit: 'd', angle: 'f', prompt: 's', refs: [], params },
    [portrait.hash],
  );
  return { portrait, sheet };
}

describe('tombstones in tasks.jsonl', () => {
  it('leaves a done task out of the graph once its last record is a tombstone', async () => {
    const { paths, cleanup } = await project();
    try {
      const { portrait, sheet } = portraitAndSheet();
      await logTask(paths, portrait);
      await logTask(paths, sheet);
      await logTombstone(paths, portrait);

      const graph = await loadGraph(paths);
      expect(graph.get(portrait.hash)).toBeUndefined();
      expect(graph.get(sheet.hash)?.status).toBe('pending');
    } finally {
      await cleanup();
    }
  });

  it('writes the requeue shape plus removed, with no output or error', async () => {
    const { paths, cleanup } = await project();
    try {
      const { portrait } = portraitAndSheet();
      await logTombstone(paths, { ...portrait, error: 'old failure' });

      const [record] = await readJsonl<Record<string, unknown>>(paths.tasksLog);
      expect(record).toEqual({
        hash    : portrait.hash,
        kind    : 'portrait',
        deps    : [],
        inputs  : portrait.inputs,
        status  : 'pending',
        attempts: portrait.attempts,
        removed : true,
      });
    } finally {
      await cleanup();
    }
  });

  it('lets a later task record for the same hash supersede the tombstone', async () => {
    const { paths, cleanup } = await project();
    try {
      const { portrait } = portraitAndSheet();
      await logTask(paths, portrait);
      await logTombstone(paths, portrait);
      await logTask(paths, { ...portrait, output: undefined, status: 'pending' });

      const graph = await loadGraph(paths);
      expect(graph.get(portrait.hash)?.status).toBe('pending');
      expect(graph.ready().map((t) => t.hash)).toEqual([portrait.hash]);
    } finally {
      await cleanup();
    }
  });

  /**
   * A collaborator on a build from before tombstones replays last-writer-wins with no rule for
   * `removed`, so the tombstone must read as an ordinary requeued task.
   */
  it('replays as a requeued task in a build that predates the rule', async () => {
    const { paths, cleanup } = await project();
    try {
      const { portrait, sheet } = portraitAndSheet();
      await logTask(paths, portrait);
      await logTask(paths, sheet);
      await logTombstone(paths, portrait);

      const records = (await readFile(paths.tasksLog, 'utf8'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as AnyTask);
      const latest = new Map<string, AnyTask>();
      for (const record of records) latest.set(record.hash, record);
      const old = new TaskGraph();
      for (const task of latest.values()) old.add(task);

      expect(old.get(portrait.hash)).toMatchObject({ status: 'pending', deps: [] });
      expect(old.get(portrait.hash)?.output).toBeUndefined();
      expect(old.topoOrder()).toEqual([portrait.hash, sheet.hash]);
      expect(old.ready().map((t) => t.hash)).toEqual([portrait.hash]);
    } finally {
      await cleanup();
    }
  });
});
