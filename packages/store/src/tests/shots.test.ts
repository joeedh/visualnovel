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
    id         : 'arrival__establishing',
    sceneId    : 'arrival',
    framing    : 'establishing',
    location   : 'evening',
    subjects   : [],
    coversLines: ['arrival:L1', 'arrival:L2'],
    status     : 'pending',
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
      camera  : 'slow push in',
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
      image : 'deadbeef',
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
        mode  : 'chunks',
        mute  : ['camera'],
        append: { subject: { text: 'Seen from behind.', of: 'abc123' } },
      },
    });
    await writeShots(paths, 'arrival', [overridden]);

    const raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    // An override is authored rather than run output, so it sits at the top level beside artNotes.
    expect(raw.shots[0].promptOverride.mute).toEqual(['camera']);
    expect(raw.shots[0].shotData).toBeUndefined();

    expect((await readShots(paths, 'arrival'))?.shots).toEqual([overridden]);
    // A second write of what was just read must produce identical bytes.
    expect(await writeShots(paths, 'arrival', [overridden])).toBe(false);
  });

  it('round-trips a relaxed cast rule, and writes nothing for the ordinary one', async () => {
    const paths = await tempPaths();
    const relaxed = shot({ castOptional: true });
    await writeShots(paths, 'arrival', [relaxed]);

    const raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.shots[0].castOptional).toBe(true);
    expect((await readShots(paths, 'arrival'))?.shots).toEqual([relaxed]);
    expect(await writeShots(paths, 'arrival', [relaxed])).toBe(false);

    await writeShots(paths, 'arrival', [shot()]);
    const plain = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect('castOptional' in plain.shots[0]).toBe(false);
  });

  it('round-trips a shot’s own aspect ratio, and writes no key for a shot without one', async () => {
    const paths = await tempPaths();
    const tall = shot({ aspect: '3:4', seed: 5 });
    await writeShots(paths, 'arrival', [tall]);

    const raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.shots[0].aspect).toBe('3:4');
    expect((await readShots(paths, 'arrival'))?.shots).toEqual([tall]);
    expect(await writeShots(paths, 'arrival', [tall])).toBe(false);

    await writeShots(paths, 'arrival', [shot()]);
    const plain = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect('aspect' in plain.shots[0]).toBe(false);
  });

  const page = (): Shot =>
    shot({
      subjects: [{ characterId: 'aiko' }, { characterId: 'ren' }],
      panels: [
        {
          shape: [
            [0, 0],
            [1, 0],
            [1, 0.5],
            [0, 0.5],
          ],
          framing    : 'wide',
          camera     : 'low angle',
          subjects   : [{ characterId: 'aiko', expression: 'startled' }],
          coversLines: ['arrival:L1'],
        },
        {
          shape: [
            [0, 0.5],
            [1, 0.5],
            [1, 1],
            [0, 1],
          ],
          framing    : 'close',
          subjects   : [{ characterId: 'ren' }],
          coversLines: ['arrival:L2'],
          artNotes   : 'rain on the glass',
        },
      ],
    });

  it('round-trips a page shot’s panels as authored material, and writes no key for a frame', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [page()]);

    const raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.shots[0].panels).toHaveLength(2);
    expect(raw.shots[0].panels[1].artNotes).toBe('rain on the glass');
    expect(raw.shots[0].shotData).toBeUndefined();
    const loaded = await readShots(paths, 'arrival');
    expect(loaded?.shots).toEqual([page()]);
    expect(loaded?.unpanelled).toEqual([]);
    expect(await writeShots(paths, 'arrival', [page()])).toBe(false);

    await writeShots(paths, 'arrival', [shot()]);
    const plain = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect('panels' in plain.shots[0]).toBe(false);
  });

  it('cuts a panel’s lines down to the shot’s, and reports the lines no panel letters', async () => {
    const paths = await tempPaths();
    const wide = page();
    wide.coversLines = ['arrival:L1', 'arrival:L2', 'arrival:L3'];
    wide.panels![0]!.coversLines = ['arrival:L1', 'arrival:L9'];
    await writeShots(paths, 'arrival', [wide]);

    // L9 is in a panel but not in the shot, and L2 leaves the scene with the shot's own list.
    const loaded = await readShots(paths, 'arrival', new Set(['arrival:L1', 'arrival:L3']));
    expect(loaded?.shots[0]?.coversLines).toEqual(['arrival:L1', 'arrival:L3']);
    expect(loaded?.shots[0]?.panels?.map((p) => p.coversLines)).toEqual([['arrival:L1'], []]);
    expect(loaded?.dropped).toEqual([{ shotId: 'arrival__establishing', lineIds: ['arrival:L2'] }]);
    expect(loaded?.unpanelled).toEqual([
      { shotId: 'arrival__establishing', lineIds: ['arrival:L3'] },
    ]);
  });

  it('refuses a panel that casts someone outside the shot’s cast, naming both', async () => {
    const paths = await tempPaths();
    const wrong = page();
    wrong.subjects = [{ characterId: 'aiko' }];
    await writeShots(paths, 'arrival', [wrong]);
    await expect(readShots(paths, 'arrival')).rejects.toMatchObject({
      diagnostics: [
        {
          code   : 'panel_subject_not_in_cast',
          message: expect.stringContaining('panel 2 of arrival__establishing casts "ren"'),
        },
      ],
    });
  });

  it('writes the observed panel boxes beside the image alone', async () => {
    const paths = await tempPaths();
    const boxes = [{ x: 0, y: 0, w: 1, h: 0.5 }];
    await writeShots(paths, 'arrival', [page(), { ...page(), id: 'x', panelBoxes: boxes }]);
    let raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    // No image, so no boxes: they describe bytes that do not exist.
    expect(raw.shots[1].shotData).toBeUndefined();

    const drawn = { ...page(), image: 'deadbeef', status: 'accepted' as const, panelBoxes: boxes };
    await writeShots(paths, 'arrival', [drawn]);
    raw = JSON.parse(await readFile(paths.shotsFile('arrival'), 'utf8'));
    expect(raw.shots[0].panelBoxes).toBeUndefined();
    expect(raw.shots[0].shotData.panelBoxes).toEqual(boxes);
    expect((await readShots(paths, 'arrival'))?.shots).toEqual([drawn]);
  });

  it('round-trips the staging groups and carries them through a write that says nothing', async () => {
    const paths = await tempPaths();
    const sheets = { staging: { seed: 3, notes: 'the whole café' } };
    await writeShots(paths, 'arrival', [shot({ sheet: 'staging' })], { sheets });
    expect(await readShots(paths, 'arrival')).toMatchObject({
      sheets,
      shots: [{ sheet: 'staging' }],
    });

    await writeShots(paths, 'arrival', [shot({ sheet: 'staging', framing: 'wide' })]);
    expect((await readShots(paths, 'arrival'))?.sheets).toEqual(sheets);
    // A decomposed file never carries the key.
    await writeShots(paths, 'other', [shot({ sceneId: 'other' })]);
    const raw = JSON.parse(await readFile(paths.shotsFile('other'), 'utf8'));
    expect('sheets' in raw).toBe(false);
  });

  it('refuses an aspect that is not two whole numbers', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [shot()]);
    const text = await readFile(paths.shotsFile('arrival'), 'utf8');
    await writeFile(
      paths.shotsFile('arrival'),
      text.replace('"framing"', '"aspect":"wide","framing"'),
    );
    await expect(readShots(paths, 'arrival')).rejects.toThrow(ValidationError);
  });

  it('round-trips a chunk’s references, pin and binding both', async () => {
    const paths = await tempPaths();
    const withRefs = shot({
      promptOverride: {
        mode: 'chunks',
        refs: {
          subject: [
            {
              pin : 'cc33',
              ext : 'png',
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
    // The planner, fallout and outfit writers all rewrite shots they loaded, and dropping the
    // mark on the way through would allow id reuse.
    await writeShots(paths, 'arrival', [shot({ framing: 'wide' })]);
    expect((await readShots(paths, 'arrival'))?.nextShot).toBe(4);
    // And preserving it keeps the unchanged rerun byte-identical.
    expect(await writeShots(paths, 'arrival', [shot({ framing: 'wide' })])).toBe(false);
  });

  it('deletes a file so the scene reads as undecomposed again', async () => {
    const paths = await tempPaths();
    await writeShots(paths, 'arrival', [shot()]);

    expect(await deleteShots(paths, 'arrival')).toBe(true);
    // The file is absent rather than empty; an empty list would be a permanent blank storyboard.
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
