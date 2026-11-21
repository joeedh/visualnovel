/**
 * The task log's writers: `logTask` in `@vn/taskgraph/write`, which can write any status, and the
 * maintenance writers in `@vn/taskgraph/maintain`, which cannot record new work. The first test
 * holds the line against a raw append that would go around both.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pins } from '@vn/contracts';
import type { AnyTask } from '@vn/types';
import { readJsonl } from '@vn/util';
import { ProjectPaths } from '@vn/store';
import { makeTask } from '../index.js';
import { logRequeue, logRestored } from '../maintain.js';
import { logDoneWriters } from '../write.js';

const REPO = resolve(__dirname, '../../../..');

/**
 * Lists every `.ts` file under `dir` that git tracks or would track, so installs and gitignored
 * build output (`dist/`, the desktop's packaged copies of the source) are never scanned.
 */
function sources(dir: string): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', dir],
    { cwd: REPO, encoding: 'utf8' },
  );
  return listed
    .split('\0')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(REPO, f))
    .filter((f) => existsSync(f));
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

/** The lintrix allow entries, by element. */
async function allowLists(): Promise<Record<string, string[]>> {
  const config = JSON.parse(await readFile(join(REPO, 'lintrix.config.json'), 'utf8')) as {
    overrides: { rules?: Record<string, unknown> }[];
  };
  for (const o of config.overrides) {
    const rule = o.rules?.['vn/element-types'];
    if (Array.isArray(rule)) return (rule[1] as { allow: Record<string, string[]> }).allow;
  }
  throw new Error('lintrix.config.json has no vn/element-types options');
}

describe(pins(logDoneWriters), () => {
  it('lets only the scheduler and adoption import the writer that can write `done`', async () => {
    const allow = await allowLists();
    const importers = Object.keys(allow).filter((element) =>
      allow[element]!.includes('taskgraph-write'),
    );
    // `taskgraph` itself is listed only for its `contracts.ts`, which reads the declaration
    expect(importers.sort()).toEqual(['artgen-adopt', 'scheduler', 'taskgraph']);
    expect(Object.keys(allow).filter((e) => allow[e]!.includes('artgen-adopt'))).toEqual([
      'artgen',
    ]);

    const files = [...sources(join(REPO, 'packages')), ...sources(join(REPO, 'apps'))].map((f) =>
      relative(REPO, f).replace(/\\/g, '/'),
    );
    const writers: string[] = [];
    for (const file of files.filter((f) => !f.includes('/tests/'))) {
      if (/from '@vn\/taskgraph\/write'/.test(await readFile(join(REPO, file), 'utf8'))) {
        writers.push(file);
      }
    }
    expect(
      writers.filter(
        (f) => !f.startsWith('packages/scheduler/src/') && f !== 'packages/artgen/src/adopt.ts',
      ),
    ).toEqual([]);
    expect(writers).toContain('packages/artgen/src/adopt.ts');
  });

  it('leaves no file but the two writer entries appending to tasksLog directly', async () => {
    const allowed = new Set([
      'packages/taskgraph/src/write.ts',
      'packages/taskgraph/src/maintain.ts',
    ]);
    const files = [
      ...sources(join(REPO, 'packages')),
      ...sources(join(REPO, 'apps')),
      ...sources(join(REPO, 'plugins')),
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
