import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  noteReview,
  noteTask,
  withRequestStop,
  withTaskLog,
  withTaskLogScope,
} from '@vn/providers';
import { TASKLOG_MAX_BYTES, TaskLogFile, readTaskLog } from '../tasklog.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tasklog-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const review = (prompt: string) => ({
  t         : 'review' as const,
  reviewer  : 'claude',
  systemText: 'be careful',
  prompt,
  images   : [{ hash: 'abc' }],
  responses: ['{}'],
  ms       : 5,
});

it('stamps scope, attempt and execution, and logs nothing outside a scope', async () => {
  const file = join(dir, 'a.jsonl');
  const sink = new TaskLogFile(file, 'exec-1', () => 'T');
  noteTask('info', 'nowhere');
  await withTaskLog(sink, async () => {
    noteTask('retry', 'outer');
    await withTaskLogScope({ attempt: 2 }, () =>
      withTaskLogScope({ source: 'reviewer:claude' }, async () => {
        noteTask('retry', 'inner');
        noteReview(review('p'));
      }),
    );
  });
  await sink.settled();
  expect(await readTaskLog(file)).toEqual([
    { t: 'log', execution: 'exec-1', at: 'T', level: 'retry', source: 'provider', text: 'outer' },
    {
      t        : 'log',
      execution: 'exec-1',
      at       : 'T',
      level    : 'retry',
      source   : 'reviewer:claude',
      text     : 'inner',
      attempt  : 2,
    },
    expect.objectContaining({ t: 'system', text: 'be careful' }),
    expect.objectContaining({ t: 'review', attempt: 2, prompt: 'p' }),
  ]);
});

it('keeps parallel appends whole and writes a system prompt once', async () => {
  const file = join(dir, 'b.jsonl');
  const sink = new TaskLogFile(file, 'exec-1');
  const big = 'x'.repeat(50_000);
  for (let i = 0; i < 20; i++) sink.append(review(`${i}${big}`));
  await sink.settled();
  const entries = await readTaskLog(file);
  expect(entries.filter((e) => e.t === 'system')).toHaveLength(1);
  expect(entries.filter((e) => e.t === 'review')).toHaveLength(20);
  // A second execution of the same task reuses the prompt already in the file
  const again = new TaskLogFile(file, 'exec-2');
  again.append(review('again'));
  await again.settled();
  expect((await readTaskLog(file)).filter((e) => e.t === 'system')).toHaveLength(1);
});

it('drops an append made after the owner abandoned the execution', async () => {
  const file = join(dir, 'c.jsonl');
  const sink = new TaskLogFile(file, 'exec-1');
  const abort = new AbortController();
  abort.abort();
  await withRequestStop({ abort: abort.signal }, async () => {
    sink.append({ t: 'log', level: 'error', source: 'runner', text: 'late' });
  });
  await sink.settled();
  expect(await readTaskLog(file)).toEqual([]);
});

it('trims the oldest execution once the file is too large', async () => {
  const file = join(dir, 'd.jsonl');
  const chunk = 'y'.repeat(10_000);
  const old = new TaskLogFile(file, 'old');
  for (let i = 0; i * chunk.length < TASKLOG_MAX_BYTES; i++) {
    old.append({ t: 'log', level: 'info', source: 'runner', text: chunk });
  }
  await old.settled();
  const fresh = new TaskLogFile(file, 'new');
  fresh.append({ t: 'log', level: 'info', source: 'runner', text: 'kept' });
  await fresh.settled();
  const entries = await readTaskLog(file);
  expect(entries).toEqual([expect.objectContaining({ execution: 'new', text: 'kept' })]);
});

it('skips a torn last line', async () => {
  const file = join(dir, 'e.jsonl');
  await writeFile(
    file,
    '{"t":"log","execution":"e","at":"T","level":"info","source":"runner","text":"ok"}\n{"t":"lo',
  );
  expect(await readTaskLog(file)).toHaveLength(1);
  expect(await readFile(file, 'utf8')).toContain('{"t":"lo');
});
