import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Shot } from '@vn/types';
import { ValidationError, ensureDir } from '@vn/util';
import { ProjectPaths, readShots, writeShots } from '../index.js';

async function tempPaths(): Promise<ProjectPaths> {
  return new ProjectPaths(await mkdtemp(join(tmpdir(), 'vn-shots-')));
}

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'arrival__establishing',
    sceneId: 'arrival',
    framing: 'establishing',
    location: 'evening',
    subjects: [],
    coversLines: ['arrival:L1', 'arrival:L2'],
    status: 'pending',
    ...overrides,
  };
}

describe('shots file', () => {
  it('returns null when no file exists', async () => {
    expect(await readShots(await tempPaths(), 'arrival')).toBeNull();
  });

  it('round-trips the authored half and omits shotData until a run produced something', async () => {
    const paths = await tempPaths();
    const authored = shot({
      camera: 'slow push in',
      subjects: [{ characterId: 'aiko', outfit: 'default' }],
    });
    expect(await writeShots(paths, 'arrival', [authored])).toBe(true);

    const raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.scene).toBe('arrival');
    expect(raw.shots[0].shotData).toBeUndefined();
    expect(raw.shots[0].coversLines).toEqual(['arrival:L1', 'arrival:L2']);

    const loaded = await readShots(paths, 'arrival');
    expect(loaded?.shots).toEqual([authored]);
    expect(loaded?.dropped).toEqual([]);
  });

  it('nests run state under shotData and reads it back onto the flat shot', async () => {
    const paths = await tempPaths();
    const ran = shot({ prompt: 'an evening street', image: 'deadbeef', status: 'accepted' });
    await writeShots(paths, 'arrival', [ran]);

    const raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.shots[0].shotData).toEqual({
      prompt: 'an evening street',
      image: 'deadbeef',
      status: 'accepted',
    });
    // The derived fields live only under shotData on disk.
    expect(raw.shots[0].prompt).toBeUndefined();
    expect(raw.shots[0].image).toBeUndefined();
    expect(raw.shots[0].status).toBeUndefined();

    expect((await readShots(paths, 'arrival'))?.shots).toEqual([ran]);
  });

  it('skips an identical rewrite so an unchanged rerun leaves the tree clean', async () => {
    const paths = await tempPaths();
    expect(await writeShots(paths, 'arrival', [shot()])).toBe(true);
    expect(await writeShots(paths, 'arrival', [shot()])).toBe(false);
    expect(await writeShots(paths, 'arrival', [shot({ framing: 'wide' })])).toBe(true);
  });

  it('drops line ids the scene no longer has, keeps the shot, and reports the drop', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [shot({ coversLines: ['arrival:L1', 'arrival:L9'] })]);

    const loaded = await readShots(paths, 'arrival', new Set(['arrival:L1', 'arrival:L2']));
    expect(loaded?.shots).toHaveLength(1);
    expect(loaded?.shots[0]?.coversLines).toEqual(['arrival:L1']);
    expect(loaded?.dropped).toEqual([{ shotId: 'arrival__establishing', lineIds: ['arrival:L9'] }]);
  });

  it('throws on a malformed file rather than silently re-decomposing over a hand edit', async () => {
    const paths = await tempPaths();
    await ensureDir(join(paths.work, 'shots'));
    await writeFile(paths.shotsFile('arrival'), '{ "version": 2, "scene": "arrival" }');
    await expect(readShots(paths, 'arrival')).rejects.toBeInstanceOf(ValidationError);

    await writeFile(paths.shotsFile('arrival'), 'not json at all');
    await expect(readShots(paths, 'arrival')).rejects.toBeInstanceOf(ValidationError);
  });
});
