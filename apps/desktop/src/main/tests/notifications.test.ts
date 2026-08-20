import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTIFICATION_VERSION, type Notification, type NotificationInput } from '@vn/types';
import {
  appendNotification,
  buildNotification,
  NotificationHub,
  readNotifications,
  setNotificationFlags,
  truncateNotifications,
} from '../notifications.js';

const input = (over: Partial<NotificationInput> = {}): NotificationInput => ({
  category: 'command',
  message: 'Renamed the scene',
  ...over,
});

describe('notifications log', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vn-notify-'));
    file = join(dir, 'notifications.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is empty when the file is not there', async () => {
    await expect(readNotifications(file)).resolves.toEqual([]);
  });

  it('writes the mutable flags in the line head, ahead of any authored text', async () => {
    await appendNotification(file, buildNotification(input()));
    const line = (await readFile(file, 'utf8')).trim();
    expect(line.startsWith(`{"v":${NOTIFICATION_VERSION},"r":0,"h":0,"id":`)).toBe(true);
  });

  it('round-trips what it appended, oldest first', async () => {
    const first = buildNotification(input({ message: 'one' }), new Date('2026-08-16T10:00:00Z'));
    const second = buildNotification(input({ message: 'two' }), new Date('2026-08-16T11:00:00Z'));
    await appendNotification(file, second);
    await appendNotification(file, first);

    const all = await readNotifications(file);
    expect(all.map((n) => n.message)).toEqual(['one', 'two']);
  });

  it('keeps a link, and defaults level and source', async () => {
    const note = buildNotification(
      input({ category: 'asset', link: { editor: 'asset', subject: 'abc' } }),
    );
    await appendNotification(file, note);

    const [read] = await readNotifications(file);
    expect(read?.link).toEqual({ editor: 'asset', subject: 'abc' });
    expect(read?.level).toBe('info');
    expect(read?.source).toBe('main');
  });

  // A string index into the file is not a byte offset once anything above the patched line is
  // multi-byte, and this app's own messages are full of `⟲`, `…` and em-dashes. The non-ASCII
  // therefore goes in the line ahead of the one being patched, and the neighbour is asserted too.
  it('patches one byte at a byte offset, past multi-byte text in an earlier line', async () => {
    const earlier = buildNotification(
      input({ message: '⟲ Undid “Rename scene” — 3 files…' }),
      new Date('2026-08-16T10:00:00Z'),
    );
    const target = buildNotification(input({ message: 'plain' }), new Date('2026-08-16T11:00:00Z'));
    await appendNotification(file, earlier);
    await appendNotification(file, target);

    const before = await readFile(file);
    await expect(setNotificationFlags(file, target.id, { read: true })).resolves.toBe(true);
    const after = await readFile(file);

    expect(after.length).toBe(before.length);
    const differing = [...after].reduce((n, b, i) => (b === before[i] ? n : n + 1), 0);
    expect(differing).toBe(1);

    const all = await readNotifications(file);
    expect(all.find((n) => n.id === earlier.id)?.message).toBe(earlier.message);
    expect(all.find((n) => n.id === target.id)?.r).toBe(1);
    expect(all.find((n) => n.id === earlier.id)?.r).toBe(0);
  });

  it('sets both flags, and clears one again', async () => {
    const note = buildNotification(input());
    await appendNotification(file, note);

    await setNotificationFlags(file, note.id, { read: true, hidden: true });
    let [read] = await readNotifications(file);
    expect([read?.r, read?.h]).toEqual([1, 1]);

    await setNotificationFlags(file, note.id, { hidden: false });
    [read] = await readNotifications(file);
    expect([read?.r, read?.h]).toEqual([1, 0]);
  });

  it('reports nothing written for an id the file does not hold', async () => {
    await appendNotification(file, buildNotification(input()));
    await expect(setNotificationFlags(file, 'not-here', { read: true })).resolves.toBe(false);
  });

  it('folds a union-merged duplicate by ORing the flags', async () => {
    const note = buildNotification(input());
    const mine: Notification = { ...note, r: 1, h: 0 };
    const theirs: Notification = { ...note, r: 0, h: 1 };
    await writeFile(file, `${JSON.stringify(mine)}\n${JSON.stringify(theirs)}\n`);

    const all = await readNotifications(file);
    expect(all).toHaveLength(1);
    expect([all[0]?.r, all[0]?.h]).toEqual([1, 1]);
  });

  it('patches every copy of a duplicated line, so the OR cannot resurrect the old value', async () => {
    const note = buildNotification(input());
    await appendNotification(file, note);
    await appendNotification(file, note);

    await setNotificationFlags(file, note.id, { hidden: true });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.includes('"h":1'))).toBe(true);
  });

  it('skips a half-written line rather than losing the file to it', async () => {
    const note = buildNotification(input({ message: 'survived' }));
    await appendNotification(file, note);
    await writeFile(file, (await readFile(file, 'utf8')) + '{"v":1,"r":0,"h":0,"id":"tru', {
      flag: 'w',
    });

    const all = await readNotifications(file);
    expect(all.map((n) => n.message)).toEqual(['survived']);
  });

  it('skips a line from a build that is newer than this one', async () => {
    const note = buildNotification(input({ message: 'mine' }));
    const future = {
      ...buildNotification(input({ message: 'theirs' })),
      v: NOTIFICATION_VERSION + 1,
    };
    await writeFile(file, `${JSON.stringify(note)}\n${JSON.stringify(future)}\n`);

    const all = await readNotifications(file);
    expect(all.map((n) => n.message)).toEqual(['mine']);
  });

  it('tolerates CRLF, whatever checkout produced the file', async () => {
    const note = buildNotification(input({ message: 'crlf' }));
    await writeFile(file, `${JSON.stringify(note)}\r\n`);

    const all = await readNotifications(file);
    expect(all.map((n) => n.message)).toEqual(['crlf']);
    await expect(setNotificationFlags(file, note.id, { read: true })).resolves.toBe(true);
    expect((await readNotifications(file))[0]?.r).toBe(1);
  });

  it('truncates to nothing but keeps the file', async () => {
    await appendNotification(file, buildNotification(input()));
    await truncateNotifications(file);

    await expect(readNotifications(file)).resolves.toEqual([]);
    await expect(readFile(file, 'utf8')).resolves.toBe('');
  });
});

describe('the hub', () => {
  let dir: string;
  let file: string;
  let pushed: (Notification | undefined)[];
  let hub: NotificationHub;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vn-notify-hub-'));
    file = join(dir, 'notifications.jsonl');
    pushed = [];
    hub = new NotificationHub({ file: () => file, push: (note) => pushed.push(note) });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('holds a post until the workspace is open, then writes it', async () => {
    await hub.post(input({ message: 'early' }));
    await expect(readNotifications(file)).resolves.toEqual([]);

    await hub.open();
    expect((await readNotifications(file)).map((n) => n.message)).toEqual(['early']);
  });

  it('announces a flag change as well as a post, so any caller leaves the bell honest', async () => {
    await hub.open();
    const note = await hub.post(input());
    expect(pushed).toEqual([note]);

    await hub.setFlags(note.id, { read: true });
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toBeUndefined();
  });

  it('says nothing when a flag change matched nothing', async () => {
    await hub.open();
    await expect(hub.setFlags('no-such-id', { hidden: true })).resolves.toBe(false);
    expect(pushed).toEqual([]);
    expect(await hub.hideAll([])).toBe(0);
    expect(pushed).toEqual([]);
  });
});
