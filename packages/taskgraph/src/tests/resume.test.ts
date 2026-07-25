import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageParams } from '@vn/types';
import { ProjectPaths } from '@vn/store';
import { loadGraph, logTask, makeTask, TaskGraph } from '../index.js';

const params: ImageParams = { modelId: 'm' };

describe('resumability via the status log', () => {
  it('replays tasks.jsonl so a re-run skips done work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vn-tg-'));
    const paths = new ProjectPaths(root);

    const g1 = new TaskGraph();
    const portrait = g1.add(
      makeTask('portrait', { characterId: 'aiko', prompt: 'p', refs: [], params }),
    );
    const sheet = g1.add(
      makeTask(
        'model_sheet',
        { characterId: 'aiko', outfit: 'd', angle: 'f', prompt: 's', refs: [], params },
        [portrait.hash],
      ),
    );
    await logTask(paths, portrait);
    await logTask(paths, sheet);

    // Portrait completes; its final state is appended again (last-writer-wins).
    g1.setStatus(portrait.hash, 'done', { output: 'asset1' });
    await logTask(paths, g1.get(portrait.hash)!);

    const g2 = await loadGraph(paths);
    expect(g2.get(portrait.hash)!.status).toBe('done');
    expect(g2.get(portrait.hash)!.output).toBe('asset1');
    expect(g2.get(sheet.hash)!.status).toBe('pending');
    // The done portrait is skipped; only the sheet is ready to run.
    expect(g2.ready().map((t) => t.hash)).toEqual([sheet.hash]);
  });
});
