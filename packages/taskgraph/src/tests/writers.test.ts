/**
 * The task log's writers: `logTask` in `@vn/taskgraph/write`, which can write any status, and the
 * maintenance writers in `@vn/taskgraph/maintain`, which cannot record new work. The first test
 * holds the line against a raw append that would go around both.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { AnyTask } from '@vn/types';
import { readJsonl } from '@vn/util';
import { ProjectPaths } from '@vn/store';
import { makeTask } from '../index.js';
import { logRequeue, logRestored } from '../maintain.js';

const REPO = resolve(__dirname, '../../../..');

/** Every `.ts` file under `dir`, skipping installs and build output. */
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const at = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(at)));
    else if (entry.name.endsWith('.ts')) out.push(at);
  }
  return out;
}

async function project(): Promise<{ paths: ProjectPaths; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'vn-writers-'));
  return { paths: new ProjectPaths(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const done = (): AnyTask => ({
  ...makeTask('portrait', {
    characterId: 'aiko',
    prompt     : 'a portrait',
    refs       : [],
    params     : { modelId: 'm' },
  }),
  status     : 'done',
  output     : 'asset1',
  error      : 'an old failure',
  checkpoint : { id: 'c1', records: [1], signature: 's' },
  interrupted: true,
});

describe('the task log writers', () => {
  it('leaves no file but the two writer entries appending to tasksLog directly', async () => {
    const allowed = new Set([
      'packages/taskgraph/src/write.ts',
      'packages/taskgraph/src/maintain.ts',
    ]);
    const files = [
      ...(await sources(join(REPO, 'packages'))),
      ...(await sources(join(REPO, 'apps'))),
      ...(await sources(join(REPO, 'plugins'))),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO, file).replace(/\\/g, '/');
      if (allowed.has(rel)) continue;
      if (/appendJsonl\(\s*[^,)]*tasksLog/.test(await readFile(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('requeues as pending, whatever the record it is handed says', async () => {
    const { paths, cleanup } = await project();
    try {
      await logRequeue(paths, done());
      const [record] = await readJsonl<Record<string, unknown>>(paths.tasksLog);
      expect(record).toMatchObject({ status: 'pending' });
      expect(record).not.toHaveProperty('output');
      expect(record).not.toHaveProperty('error');
      expect(record).not.toHaveProperty('checkpoint');
      expect(record).not.toHaveProperty('interrupted');
    } finally {
      await cleanup();
    }
  });

  it('restores a record verbatim, stamped and without the tombstone mark', async () => {
    const { paths, cleanup } = await project();
    try {
      const original = { ...done(), removed: true as const };
      const copy = await logRestored(paths, original, '2026-11-17T00:00:00.000Z');
      const [record] = await readJsonl<Record<string, unknown>>(paths.tasksLog);
      const { removed: _removed, ...rest } = original;
      expect(record).toEqual({ ...rest, restored: '2026-11-17T00:00:00.000Z' });
      expect(copy).toEqual(record);
    } finally {
      await cleanup();
    }
  });
});
