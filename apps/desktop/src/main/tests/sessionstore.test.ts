/**
 * The store is deliberately Electron-free, so its multi-instance behaviour can be exercised
 * in a plain Node process: two `SessionStore`s over one directory are exactly two app
 * instances as far as the file is concerned.
 */
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, resolveSessionDir } from '../sessionstore.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vn-session-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readRaw = (): Promise<string> => fs.readFile(join(dir, 'session.json'), 'utf8');

describe('SessionStore', () => {
  it('round-trips a value through a fresh instance', async () => {
    const a = await SessionStore.open(dir);
    expect(a.get('panel.studio.rail.width', 212)).toBe(212);
    a.set('panel.studio.rail.width', 260);
    await a.close();

    const b = await SessionStore.open(dir);
    expect(b.get('panel.studio.rail.width', 212)).toBe(260);
    expect(b.snapshot()).toEqual({ 'panel.studio.rail.width': 260 });
  });

  it('merges per key, so two instances do not clobber each other', async () => {
    const a = await SessionStore.open(dir);
    const b = await SessionStore.open(dir);
    a.set('panel.studio.rail.width', 300);
    b.set('panel.floor.inspector.width', 400);
    await Promise.all([a.close(), b.close()]);

    const c = await SessionStore.open(dir);
    expect(c.snapshot()).toEqual({
      'panel.studio.rail.width': 300,
      'panel.floor.inspector.width': 400,
    });
  });

  it('adopts the merged file, so a later flush does not resurrect a stale value', async () => {
    const a = await SessionStore.open(dir);
    const b = await SessionStore.open(dir);
    b.set('shared', 'from-b');
    await b.flush();

    a.set('own', 1);
    await a.flush();
    expect(a.get('shared', 'missing')).toBe('from-b');
  });

  it('treats a corrupt file as empty and stays writable', async () => {
    await fs.writeFile(join(dir, 'session.json'), '{ not json');
    const store = await SessionStore.open(dir);
    expect(store.snapshot()).toEqual({});

    store.set('panel.floor.inspector.width', 360);
    await store.close();
    expect(JSON.parse(await readRaw())).toEqual({ 'panel.floor.inspector.width': 360 });
  });

  it('breaks a stale lock rather than deadlocking on it', async () => {
    const lock = join(dir, 'session.lock');
    await fs.mkdir(lock);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lock, past, past);

    const store = await SessionStore.open(dir);
    store.set('panel.studio.rail.width', 240);
    await store.close();

    expect(JSON.parse(await readRaw())).toEqual({ 'panel.studio.rail.width': 240 });
    await expect(fs.stat(lock)).rejects.toThrow();
  });

  it('honours VN_DESKTOP_HOME for the store location', () => {
    const before = process.env.VN_DESKTOP_HOME;
    process.env.VN_DESKTOP_HOME = dir;
    try {
      expect(resolveSessionDir()).toBe(dir);
    } finally {
      if (before === undefined) delete process.env.VN_DESKTOP_HOME;
      else process.env.VN_DESKTOP_HOME = before;
    }
  });
});
