import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Shot } from '@vn/types';
import { ValidationError, ensureDir } from '@vn/util';
import { ProjectPaths, deleteShots, readShots, writeShots } from '../index.js';

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

  it('round-trips a prompt override as authored material', async () => {
    const paths = await tempPaths();
    const overridden = shot({
      promptOverride: {
        mode: 'chunks',
        mute: ['camera'],
        append: { subject: { text: 'Seen from behind.', of: 'abc123' } },
      },
    });
    await writeShots(paths, 'arrival', [overridden]);

    const raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    // Top level, beside artNotes: an override is something a human wrote, not run output.
    expect(raw.shots[0].promptOverride.mute).toEqual(['camera']);
    expect(raw.shots[0].shotData).toBeUndefined();

    expect((await readShots(paths, 'arrival'))?.shots).toEqual([overridden]);
    // Self-testing: a second write of what was just read must find the bytes identical.
    expect(await writeShots(paths, 'arrival', [overridden])).toBe(false);
  });

  it('round-trips a chunk’s references, pin and binding both', async () => {
    const paths = await tempPaths();
    const withRefs = shot({
      promptOverride: {
        mode: 'chunks',
        refs: {
          subject: [
            {
              pin: 'cc33',
              ext: 'png',
              from: { kind: 'plate', locationId: 'cafe', variant: 'night' },
            },
          ],
        },
      },
    });
    await writeShots(paths, 'arrival', [withRefs]);
    expect((await readShots(paths, 'arrival'))?.shots).toEqual([withRefs]);
    expect(await writeShots(paths, 'arrival', [withRefs])).toBe(false);
  });

  it('writes no key for an override that says nothing', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [shot()]);
    expect(await writeShots(paths, 'arrival', [shot({ promptOverride: { mode: 'chunks' } })])).toBe(
      false,
    );
  });

  it('round-trips the nextShot mark, and omits it until an id has been spent', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [shot()]);
    // A decomposed file never carries the field, so it stays byte-stable across versions.
    let raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.nextShot).toBeUndefined();
    expect((await readShots(paths, 'arrival'))?.nextShot).toBeUndefined();

    expect(await writeShots(paths, 'arrival', [shot()], { nextShot: 3 })).toBe(true);
    raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.nextShot).toBe(3);
    expect((await readShots(paths, 'arrival'))?.nextShot).toBe(3);
  });

  it('preserves an existing mark when the caller says nothing about it', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [shot()], { nextShot: 4 });
    // The planner, fallout and outfit writers all rewrite shots they loaded; none of them may
    // drop the mark on the way through — that would quietly resurrect id reuse.
    await writeShots(paths, 'arrival', [shot({ framing: 'wide' })]);
    expect((await readShots(paths, 'arrival'))?.nextShot).toBe(4);
    // And preserving it keeps the unchanged rerun byte-identical.
    expect(await writeShots(paths, 'arrival', [shot({ framing: 'wide' })])).toBe(false);
  });

  it('deletes a file so the scene reads as undecomposed again', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [shot()]);

    expect(await deleteShots(paths, 'arrival')).toBe(true);
    // Absent, not empty: an empty list would be a permanent blank storyboard.
    expect(await readShots(paths, 'arrival')).toBeNull();
    expect(await deleteShots(paths, 'arrival')).toBe(false);
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
