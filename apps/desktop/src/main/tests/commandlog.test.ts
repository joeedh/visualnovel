import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRecord } from '@vn/commands';
import { ProjectPaths } from '@vn/store';
import { ensureDir } from '@vn/util';
import { evidenceFor, readCommandLog } from '../commandlog.js';
import { appendItem, openThread } from '../threads.js';

const record = (seq: number, over: Partial<CommandRecord> = {}): CommandRecord => ({
  seq,
  id        : 'story.editScene',
  props     : {},
  invocation: `story.editScene(id='s1')`,
  source    : 'agent',
  mutating  : true,
  gitHead   : null,
  gitDirty  : false,
  startedAt : '2026-08-15T14:02:00.000Z',
  finishedAt: '2026-08-15T14:02:01.000Z',
  status    : 'ok',
  message   : 'Rewrote 3 lines.',
  ...over,
});

describe('readCommandLog', () => {
  let root: string;
  let paths: ProjectPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-cmdlog-'));
    paths = new ProjectPaths(root);
    await ensureDir(paths.state);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = (...lines: string[]) => appendFile(paths.commandsLog, `${lines.join('\n')}\n`);

  it('has nothing to read before a command has run', async () => {
    expect(await readCommandLog(paths)).toEqual([]);
  });

  it('reads the records in the order they were written', async () => {
    await write(JSON.stringify(record(1)), JSON.stringify(record(2)));
    expect((await readCommandLog(paths)).map((r) => r.seq)).toEqual([1, 2]);
  });

  it('skips a line a crash cut off, and one that is not a record', async () => {
    await write(JSON.stringify(record(1)), '{"seq":2,"id":"story.ed');
    await write('{"note":"not a record"}', JSON.stringify(record(3)));
    expect((await readCommandLog(paths)).map((r) => r.seq)).toEqual([1, 3]);
  });
});

describe('evidenceFor', () => {
  let root: string;
  let paths: ProjectPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-evidence-'));
    paths = new ProjectPaths(root);
    await ensureDir(paths.state);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a saved conversation and the acts that fell inside it', async () => {
    const opened = new Date('2026-08-15T14:00:00.000Z');
    const { id } = await openThread(paths, { model: 'claude-opus-5' }, opened);
    await appendItem(paths, id, { id: 1, role: 'user', text: 'go' }, opened);
    await appendItem(
      paths,
      id,
      { id: 2, role: 'agent', text: 'Done.' },
      new Date('2026-08-15T14:05:00.000Z'),
    );
    await appendFile(
      paths.commandsLog,
      `${JSON.stringify(record(1))}\n${JSON.stringify(record(2, { startedAt: '2026-08-15T15:30:00.000Z', finishedAt: '2026-08-15T15:30:01.000Z' }))}\n`,
    );

    const evidence = await evidenceFor(paths, id, { appVersion: '0.4.1' });
    expect(evidence.acts.map((r) => r.seq)).toEqual([1]);
    expect(evidence.thread.model).toBe('claude-opus-5');
    expect(evidence.context.appVersion).toBe('0.4.1');
  });

  it('is happy with a project that has never run a command', async () => {
    const { id } = await openThread(paths);
    await appendItem(paths, id, { id: 1, role: 'user', text: 'go' });
    expect((await evidenceFor(paths, id)).acts).toEqual([]);
  });
});
