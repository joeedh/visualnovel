import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectPaths } from '@vn/store';
import type { FeedItem, ThreadUsage } from '../../shared/convo.js';
import {
  ConflictedLogError,
  NATIVE_VERSION,
  NEW_THREAD_TITLE,
  appendItem,
  appendNative,
  appendUsage,
  archiveThread,
  bindThread,
  listThreads,
  nativeFile,
  nativeHeader,
  openThread,
  readNative,
  readThread,
  retitleThread,
  threadFile,
  threadsDir,
  titleFrom,
  type NativeLine,
} from '../threads.js';

const item = (id: number, role: FeedItem['role'], text: string): FeedItem => ({ id, role, text });

describe('threads', () => {
  let root: string;
  let paths: ProjectPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-threads-'));
    paths = new ProjectPaths(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lives beside the other append-only logs', () => {
    expect(threadsDir(paths)).toBe(join(root, 'vngen', 'state', 'threads'));
  });

  it('has nothing to list before anything is said', async () => {
    expect(await listThreads(paths)).toEqual([]);
  });

  it('round-trips a conversation', async () => {
    const at = new Date('2026-08-15T14:22:33');
    const header = await openThread(paths, { commit: 'a1b2c3d', model: 'claude-opus-5' }, at);
    expect(header.id).toBe('20260815-142233');
    expect(header.title).toBe(NEW_THREAD_TITLE);

    const items = [
      item(1, 'user', 'give aiko a track outfit'),
      item(2, 'tool', 'edit_character(aiko) — added outfit `track`'),
      item(3, 'agent', 'Added a track outfit.'),
    ];
    for (const feed of items) await appendItem(paths, header.id, feed);

    const read = await readThread(paths, header.id);
    expect(read.items).toMatchObject(items);
    // Every stored line is stamped, which is what a report uses to line a conversation up
    expect(read.items.every((stored) => !Number.isNaN(Date.parse(stored.at!)))).toBe(true);
    expect(read.commit).toBe('a1b2c3d');
    expect(read.model).toBe('claude-opus-5');
    expect(read.startedAt).toBe(at.toISOString());
  });

  it('gives a second thread in the same second its own file', async () => {
    const at = new Date('2026-08-15T14:22:33');
    const first = await openThread(paths, {}, at);
    const second = await openThread(paths, {}, at);
    const third = await openThread(paths, {}, at);
    expect([first.id, second.id, third.id]).toEqual([
      '20260815-142233',
      '20260815-142233-2',
      '20260815-142233-3',
    ]);
  });

  it('retitles by appending, and the last title wins', async () => {
    const { id } = await openThread(paths);
    await appendItem(paths, id, item(1, 'user', 'hello'));
    await retitleThread(paths, id, 'first go');
    await retitleThread(paths, id, 'second thoughts');

    expect((await readThread(paths, id)).title).toBe('second thoughts');
    expect((await listThreads(paths))[0]?.title).toBe('second thoughts');

    // The header line is still the one that was written, and the feed still has its one item.
    const lines = (await readFile(threadFile(paths, id), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ v: 1, type: 'thread', title: NEW_THREAD_TITLE });
    expect((await readThread(paths, id)).items).toHaveLength(1);
  });

  it('remembers the model and effort it was last had on, not the ones it opened on', async () => {
    const { id } = await openThread(paths, { model: 'claude-sonnet-5', effort: 'medium' });
    await bindThread(paths, id, { effort: 'high' });
    await bindThread(paths, id, { model: 'claude-opus-5', effort: 'xhigh' });

    expect(await readThread(paths, id)).toMatchObject({
      model: 'claude-opus-5',
      effort: 'xhigh',
    });
    // The listing reads the same binding, parsing only the header-shaped lines
    expect((await listThreads(paths))[0]).toMatchObject({ model: 'claude-opus-5' });
  });

  it('a rebind that names one field leaves the other where it was', async () => {
    const { id } = await openThread(paths, { model: 'claude-sonnet-5', effort: 'low' });
    await bindThread(paths, id, { effort: 'high' });
    expect(await readThread(paths, id)).toMatchObject({ model: 'claude-sonnet-5', effort: 'high' });

    // A rebind that names neither field appends nothing, rather than a line that says nothing
    const count = async (): Promise<number> =>
      (await readFile(threadFile(paths, id), 'utf8')).trim().split('\n').length;
    const before = await count();
    await bindThread(paths, id, {});
    const after = await count();
    expect(after).toBe(before);
  });

  it('remembers every commit its contents were saved in, oldest first', async () => {
    const { id } = await openThread(paths, { title: 'closed twice' });
    await appendItem(paths, id, item(1, 'user', 'hello'));
    expect((await readThread(paths, id)).archived).toBeUndefined();

    await archiveThread(paths, id, 'a'.repeat(40));
    await archiveThread(paths, id, 'b'.repeat(40));

    expect((await readThread(paths, id)).archived).toMatchObject([
      { commit: 'a'.repeat(40) },
      { commit: 'b'.repeat(40) },
    ]);
    // The listing reads the archive too, so a row can say a conversation is in history without
    // being opened
    expect((await listThreads(paths))[0]!.archived).toHaveLength(2);
  });

  it('lists newest first', async () => {
    await openThread(paths, { title: 'monday' }, new Date('2026-08-10T09:00:00'));
    await openThread(paths, { title: 'wednesday' }, new Date('2026-08-12T09:00:00'));
    await openThread(paths, { title: 'tuesday' }, new Date('2026-08-11T09:00:00'));

    expect((await listThreads(paths)).map((t) => t.title)).toEqual([
      'wednesday',
      'tuesday',
      'monday',
    ]);
  });

  it('still lists and replays a log a crash cut off mid-line', async () => {
    const { id } = await openThread(paths, { title: 'interrupted' });
    await appendItem(paths, id, item(1, 'user', 'rewrite the café sheet'));
    await appendFile(threadFile(paths, id), '{"type":"item","id":2,"role":"age');

    expect((await listThreads(paths)).map((t) => t.title)).toEqual(['interrupted']);
    expect((await readThread(paths, id)).items).toMatchObject([
      item(1, 'user', 'rewrite the café sheet'),
    ]);
  });

  it('ignores a file that is not a thread, and names the id when asked for one', async () => {
    await openThread(paths, { title: 'real' });
    await writeFile(join(threadsDir(paths), 'junk.jsonl'), '{"type":"item","id":1}\n');
    await writeFile(join(threadsDir(paths), 'notes.txt'), 'not a thread\n');

    expect((await listThreads(paths)).map((t) => t.title)).toEqual(['real']);
    await expect(readThread(paths, 'junk')).rejects.toThrow(/no such conversation: junk/);
  });

  it('caps a long transcript line rather than storing a file twice', async () => {
    const { id } = await openThread(paths);
    await appendItem(paths, id, item(1, 'tool', 'x'.repeat(5000)));

    const [stored] = (await readThread(paths, id)).items;
    expect(stored!.text.length).toBeLessThan(500);
    expect(stored!.text.endsWith('…')).toBe(true);
  });

  it('keeps what a clamped line said, and only when something was cut', async () => {
    const { id } = await openThread(paths);
    await appendItem(paths, id, item(1, 'agent', 'x'.repeat(5000)));
    await appendItem(paths, id, item(2, 'agent', 'short enough'));

    const [long, short] = (await readThread(paths, id)).items;
    expect(long!.full).toHaveLength(5000);
    expect(long!.text.length).toBeLessThan(long!.full!.length);
    expect(short!.full).toBeUndefined();
  });

  it('caps the kept text too — a thread is a log, not an archive', async () => {
    const { id } = await openThread(paths);
    await appendItem(paths, id, item(1, 'agent', 'x'.repeat(20_000)));

    const [stored] = (await readThread(paths, id)).items;
    expect(stored!.full!.length).toBeLessThan(8100);
    expect(stored!.full!.endsWith('…')).toBe(true);
  });

  it('round-trips a tool call’s args and result, each capped on its own', async () => {
    const { id } = await openThread(paths);
    await appendItem(paths, id, {
      ...item(1, 'tool', 'read_file'),
      detail: { args: `{"path":"${'a'.repeat(900)}"}`, ok: false, output: 'y'.repeat(5000) },
    });

    const [stored] = (await readThread(paths, id)).items;
    expect(stored!.detail!.ok).toBe(false);
    expect(stored!.detail!.args!.length).toBeLessThan(700);
    expect(stored!.detail!.output!.length).toBeLessThan(2100);
    expect(stored!.full).toBeUndefined();
  });

  it('reads a thread written before the format carried any of this', async () => {
    const { id } = await openThread(paths, { title: 'older' });
    await appendFile(
      threadFile(paths, id),
      `${JSON.stringify({ type: 'item', id: 1, role: 'tool', text: 'read_file', at: 'then' })}\n`,
    );

    expect((await readThread(paths, id)).items).toEqual([
      { ...item(1, 'tool', 'read_file'), at: 'then' },
    ]);
  });
});

describe('receipts in a thread', () => {
  let root: string;
  let paths: ProjectPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-threads-usage-'));
    paths = new ProjectPaths(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips every field a receipt carries', async () => {
    const { id } = await openThread(paths, { title: 'spend' });
    const usage: ThreadUsage[] = [
      { step: 1, input: 1000, output: 20, cacheRead: 0, cacheWrite: 900, verdict: 'cold', at: 'a' },
      {
        step: 2,
        input: 1000,
        output: 20,
        cacheRead: 900,
        cacheWrite: 80,
        cacheEstimated: true,
        verdict: 'hit',
        at: 'b',
      },
    ];
    for (const receipt of usage) await appendUsage(paths, id, receipt);

    expect((await readThread(paths, id)).usage).toEqual(usage);
  });

  it('leaves a figure the vendor never reported absent rather than zero', async () => {
    const { id } = await openThread(paths, { title: 'silent' });
    await appendUsage(paths, id, { step: 1, input: 1000, output: 20, at: 'a' });

    const [read] = (await readThread(paths, id)).usage!;
    expect(read).toEqual({ step: 1, input: 1000, output: 20, at: 'a' });
    expect('cacheRead' in read!).toBe(false);
  });

  it('is not read as a transcript line, and does not stop one being read', async () => {
    const { id } = await openThread(paths, { title: 'mixed' });
    await appendItem(paths, id, item(1, 'user', 'go'));
    await appendUsage(paths, id, { step: 1, input: 10, output: 2, verdict: 'miss', at: 'a' });
    await appendItem(paths, id, item(2, 'agent', 'done'));

    const read = await readThread(paths, id);
    expect(read.items.map((line) => line.id)).toEqual([1, 2]);
    expect(read.usage).toHaveLength(1);
  });

  it('gets no field at all on a thread that recorded none', async () => {
    const { id } = await openThread(paths, { title: 'quiet' });
    await appendItem(paths, id, item(1, 'user', 'go'));

    expect('usage' in (await readThread(paths, id))).toBe(false);
  });

  it('is ignored by the listing, which parses headers only', async () => {
    const { id } = await openThread(paths, { title: 'listed' });
    await appendUsage(paths, id, { step: 1, input: 10, output: 2, verdict: 'cold', at: 'a' });

    expect((await listThreads(paths)).map((header) => header.id)).toEqual([id]);
  });
});

describe('the native log', () => {
  let root: string;
  let paths: ProjectPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-native-'));
    paths = new ProjectPaths(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const header = (thread: string): NativeLine => ({
    v: NATIVE_VERSION,
    type: 'resume',
    thread,
    at: '2026-08-22T14:00:28.041Z',
    backend: 'native',
    vendor: 'anthropic',
    model: 'claude-opus-5',
    effort: 'low',
    sections: [
      { name: 'BUILT-IN', text: 'the contract' },
      { name: 'PROJECT MAP (GENERATED_CONTEXT.md)', text: 'the cast' },
    ],
  });

  const msg = (n: number, over: Partial<Extract<NativeLine, { type: 'msg' }>>): NativeLine => ({
    type: 'msg',
    n,
    at: '2026-08-22T14:00:29.000Z',
    role: 'user',
    content: '',
    ...over,
  });

  it('sits beside the display log, under the same id', () => {
    expect(nativeFile(paths, '20260822-140028')).toBe(
      join(threadsDir(paths), '20260822-140028.native.jsonl'),
    );
  });

  it('round-trips the header and every message, verbatim', async () => {
    const id = '20260822-140028';
    const blocks = [{ type: 'tool_use', id: 'toolu_01A', name: 'read_file' }];
    await appendNative(paths, id, header(id));
    await appendNative(paths, id, msg(0, { content: 'Draft the second scene.' }));
    await appendNative(paths, id, msg(1, { role: 'assistant', content: blocks }));
    await appendNative(
      paths,
      id,
      msg(2, { role: 'observation', toolUseId: 'toolu_01A', content: 'INT.' }),
    );

    const log = await readNative(paths, id);
    expect(log!.header).toMatchObject({
      v: NATIVE_VERSION,
      backend: 'native',
      vendor: 'anthropic',
    });
    expect(log!.messages).toEqual([
      { n: 0, role: 'user', content: 'Draft the second scene.' },
      { n: 1, role: 'assistant', content: blocks },
      { n: 2, role: 'observation', toolUseId: 'toolu_01A', content: 'INT.' },
    ]);
    // None of the display log's clamps apply: a resume replays exactly what was sent.
    expect(log!.compaction).toBeUndefined();
  });

  it('folds a sections delta onto the header, replacing in place and appending what is new', async () => {
    const id = '20260822-140028';
    await appendNative(paths, id, header(id));
    await appendNative(paths, id, {
      type: 'sections',
      n: 4,
      at: '2026-08-22T14:01:00.000Z',
      set: [
        { name: 'PROJECT MAP (GENERATED_CONTEXT.md)', text: 'the cast, rewritten' },
        { name: 'PROJECT CONTEXT (AICONTEXT.md)', text: 'be terse' },
      ],
      unset: [],
    });

    expect((await readNative(paths, id))!.sections).toEqual([
      { name: 'BUILT-IN', text: 'the contract' },
      { name: 'PROJECT MAP (GENERATED_CONTEXT.md)', text: 'the cast, rewritten' },
      { name: 'PROJECT CONTEXT (AICONTEXT.md)', text: 'be terse' },
    ]);
  });

  it('drops a section the delta unset', async () => {
    const id = '20260822-140028';
    await appendNative(paths, id, header(id));
    await appendNative(paths, id, {
      type: 'sections',
      n: 4,
      at: '2026-08-22T14:01:00.000Z',
      set: [],
      unset: ['PROJECT MAP (GENERATED_CONTEXT.md)'],
    });

    expect((await readNative(paths, id))!.sections).toEqual([
      { name: 'BUILT-IN', text: 'the contract' },
    ]);
  });

  it('reads the newest compaction, and keeps the messages it covers', async () => {
    const id = '20260822-140028';
    await appendNative(paths, id, header(id));
    for (const n of [0, 1, 2]) await appendNative(paths, id, msg(n, { content: `line ${n}` }));
    await appendNative(paths, id, {
      type: 'compact',
      at: '2026-08-22T14:03:11.204Z',
      covers: { from: 0, to: 1 },
      role: 'context',
      content: 'first summary',
    });
    await appendNative(paths, id, {
      type: 'compact',
      at: '2026-08-22T14:09:11.204Z',
      covers: { from: 0, to: 2 },
      role: 'context',
      content: 'second summary',
      model: 'claude-opus-5',
      usage: { input: 41208, output: 1104 },
    });

    const log = await readNative(paths, id);
    expect(log!.compaction).toMatchObject({
      content: 'second summary',
      covers: { from: 0, to: 2 },
    });
    // What a compaction covers stays in the file — it is what a history search reads.
    expect(log!.messages).toHaveLength(3);
  });

  it('skips a line a crash cut off, and refuses one a merge wrote two versions into', async () => {
    const id = '20260822-140028';
    await appendNative(paths, id, header(id));
    await appendNative(paths, id, msg(0, { content: 'kept' }));
    await appendFile(nativeFile(paths, id), '{"type":"msg","n":1,"role":"us');

    expect((await readNative(paths, id))!.messages).toHaveLength(1);

    await appendFile(nativeFile(paths, id), '\n<<<<<<< HEAD\n');
    await expect(readNative(paths, id)).rejects.toThrow(ConflictedLogError);
    // The cheap header read catches it too, though it parses only line 0.
    await expect(nativeHeader(paths, id)).rejects.toThrow(ConflictedLogError);
  });

  it('answers absent for a thread written before the format existed', async () => {
    const { id } = await openThread(paths, { title: 'older' });
    await appendItem(paths, id, item(1, 'user', 'hello'));

    expect(await readNative(paths, id)).toBeUndefined();
    expect(await nativeHeader(paths, id)).toBeUndefined();
  });

  it('reads line 0 alone, past a message that quotes the word', async () => {
    const id = '20260822-140028';
    await appendNative(paths, id, header(id));
    await appendNative(paths, id, msg(0, { content: 'what does {"type":"resume"} mean?' }));

    expect(await nativeHeader(paths, id)).toMatchObject({ thread: id, model: 'claude-opus-5' });
  });

  it('is one conversation: the listing counts it once and the display log is unchanged', async () => {
    const { id } = await openThread(paths, { title: 'both files' });
    await appendItem(paths, id, item(1, 'user', 'hello'));
    const before = await readFile(threadFile(paths, id), 'utf8');
    const read = await readThread(paths, id);

    await appendNative(paths, id, header(id));
    await appendNative(paths, id, msg(0, { content: 'hello' }));

    expect((await listThreads(paths)).map((t) => t.title)).toEqual(['both files']);
    expect(await readFile(threadFile(paths, id), 'utf8')).toBe(before);
    expect(await readThread(paths, id)).toEqual(read);
  });
});

describe('titleFrom', () => {
  it('takes a short turn whole, on one line', () => {
    expect(titleFrom('  give aiko\n  a track outfit ')).toBe('give aiko a track outfit');
  });

  it('trims a long turn at a word boundary', () => {
    const title = titleFrom(`${'word '.repeat(40)}end`);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title).not.toMatch(/ …$/);
  });

  it('falls back rather than naming a thread nothing', () => {
    expect(titleFrom('   ')).toBe(NEW_THREAD_TITLE);
  });
});
