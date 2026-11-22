import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { readShots, writeShots } from '@vn/store';
import { WorkspaceSession } from '../../session.js';
import { sessionFor } from './helpers.js';

/**
 * The two outfit write paths. They deliberately go to different files — the scene marker to the
 * scene chunk, the shot override to the storyboard — so each is asserted by reading the file it
 * owns back, not by the sentence the session returned.
 */
describe('WorkspaceSession — outfits', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({
      title     : 'Outfits',
      script    : SCRIPTS.linear,
      characters: [
        { id: 'aiko', outfits: { uniform: 'navy blazer', track: 'club tracksuit' } },
        { id: 'ren', outfits: { uniform: 'grey blazer' } },
      ],
    });
    session = sessionFor(p);
    await writeShots(p.paths, 'arrival', [
      {
        id         : 'arrival__beat1',
        sceneId    : 'arrival',
        framing    : 'medium',
        location   : 'classroom/day',
        subjects   : [{ characterId: 'aiko' }],
        coversLines: ['arrival:L2'],
      },
    ]);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it('patches the scene marker, and refuses the same request a second time', async () => {
    expect(await session.previewSceneOutfit('arrival', 'aiko', 'track')).toMatchObject({
      ok: true,
    });

    const result = await session.editBranches(
      await session.sceneOutfit('arrival', 'aiko', 'track'),
    );
    expect(result).toMatchObject({ ok: true, written: ['scenes/arrival.md'] });
    expect(await p.read('scenes/arrival.md')).toContain('[[outfit: aiko=track]]');

    // A noop rather than a plain refusal, so the control offering it is dropped rather than
    // disabled
    expect(await session.previewSceneOutfit('arrival', 'aiko', 'track')).toMatchObject({
      ok  : false,
      noop: true,
    });
  });

  it('overrides one subject of one shot, and clears the override back to absent', async () => {
    const set = await session.setShotOutfit('arrival', 'arrival__beat1', 'aiko', 'track');
    expect(set).toMatchObject({ ok: true, written: ['vngen/work/shots/arrival.json'] });
    expect((await readShots(p.paths, 'arrival'))?.shots[0]!.subjects).toEqual([
      { characterId: 'aiko', outfit: 'track' },
    ]);

    const cleared = await session.setShotOutfit('arrival', 'arrival__beat1', 'aiko', '');
    expect(cleared.ok).toBe(true);
    expect(cleared.message).toContain('character sheet');
    expect((await readShots(p.paths, 'arrival'))?.shots[0]!.subjects).toEqual([
      { characterId: 'aiko' },
    ]);
  });

  it('refuses an outfit the sheet never authored, naming the ones it did, and writes nothing', async () => {
    const preview = await session.previewShotOutfit(
      'arrival',
      'arrival__beat1',
      'aiko',
      'swimsuit',
    );
    expect(preview).toMatchObject({ ok: false });
    if (preview.ok) throw new Error('expected a refusal');
    expect(preview.error).toContain('"uniform", "track"');

    const run = await session.setShotOutfit('arrival', 'arrival__beat1', 'aiko', 'swimsuit');
    expect(run).toMatchObject({ ok: false, written: [] });
    expect((await readShots(p.paths, 'arrival'))?.shots[0]!.subjects).toEqual([
      { characterId: 'aiko' },
    ]);
  });

  /**
   * The timeline's outfit strip is built entirely from `story:coverage`, so this payload decides
   * both what the strip can offer and what it says is in force. A subject that inherits carries
   * nothing; the strip resolves it, and pre-filling the answer would erase the distinction.
   */
  it('carries the wardrobe and the overrides in the coverage the strip is built from', async () => {
    const before = await session.sceneCoverage('arrival');
    expect(before.cast).toContainEqual({
      id           : 'aiko',
      outfits      : ['uniform', 'track'],
      defaultOutfit: 'uniform',
    });
    expect(before.shots[0]!.outfits).toEqual({});

    await session.editBranches(await session.sceneOutfit('arrival', 'aiko', 'track'));
    await session.setShotOutfit('arrival', 'arrival__beat1', 'aiko', 'uniform');

    const after = await session.sceneCoverage('arrival');
    expect(after.cast.find((c) => c.id === 'aiko')?.marked).toBe('track');
    expect(after.shots[0]!.outfits).toEqual({ aiko: 'uniform' });
  });

  it('changes who a shot frames, keeping the override of a character that stays', async () => {
    await session.setShotOutfit('arrival', 'arrival__beat1', 'aiko', 'track');

    const set = await session.setShotSubjects('arrival', 'arrival__beat1', ['aiko', 'ren']);
    expect(set).toMatchObject({ ok: true, written: ['vngen/work/shots/arrival.json'] });
    expect((await readShots(p.paths, 'arrival'))?.shots[0]!.subjects).toEqual([
      { characterId: 'aiko', outfit: 'track' },
      { characterId: 'ren' },
    ]);

    const emptied = await session.setShotSubjects('arrival', 'arrival__beat1', []);
    expect(emptied.message).toContain('background plate');
    expect((await readShots(p.paths, 'arrival'))?.shots[0]!.subjects).toEqual([]);
  });

  it('refuses a subject no sheet describes, and writes nothing', async () => {
    const preview = await session.previewShotSubjects('arrival', 'arrival__beat1', ['nobody']);
    expect(preview).toMatchObject({ ok: false });

    const run = await session.setShotSubjects('arrival', 'arrival__beat1', ['nobody']);
    expect(run).toMatchObject({ ok: false, written: [] });
    expect((await readShots(p.paths, 'arrival'))?.shots[0]!.subjects).toEqual([
      { characterId: 'aiko' },
    ]);
  });

  it('lets a shot off showing its cast without taking the cast off the shot', async () => {
    const off = await session.requireShotCast('arrival', 'arrival__beat1', false);
    expect(off).toMatchObject({ ok: true, written: ['vngen/work/shots/arrival.json'] });
    expect((await readShots(p.paths, 'arrival'))?.shots[0]).toMatchObject({
      castOptional: true,
      subjects    : [{ characterId: 'aiko' }],
    });
    expect(off.coverage?.shots[0]!.castOptional).toBe(true);

    expect(await session.previewShotCast('arrival', 'arrival__beat1', false)).toMatchObject({
      ok  : false,
      noop: true,
    });

    const on = await session.requireShotCast('arrival', 'arrival__beat1', true);
    expect(on.ok).toBe(true);
    expect((await readShots(p.paths, 'arrival'))?.shots[0]!.castOptional).toBeUndefined();
  });

  it('places a page’s bubbles without re-keying it, and refuses them on a frame', async () => {
    expect(await session.previewBubbles('arrival', 'arrival__beat1', [])).toMatchObject({
      ok   : false,
      error: expect.stringContaining('single frame'),
    });

    const lines = (await session.sceneCoverage('arrival')).shots[0]!.coversLines;
    const whole: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const paged = await session.setPanels('arrival', 'arrival__beat1', [
      { shape: whole, framing: 'medium', subjects: [], coversLines: [lines[0]!] },
    ]);
    expect(paged.ok).toBe(true);
    const keyed = (await session.sceneCoverage('arrival')).shots[0]!;

    const placed = await session.setBubbles('arrival', 'arrival__beat1', [
      { lineId: lines[0]!, anchor: [0.5, 0.3], tail: [0.4, 0.6] },
    ]);
    expect(placed).toMatchObject({
      ok     : true,
      message: expect.stringContaining('Nothing is drawn again'),
      written: ['vngen/work/shots/arrival.json'],
    });
    const after = (await session.sceneCoverage('arrival')).shots[0]!;
    expect(placed.saved).toMatchObject({
      kind   : 'bubbles',
      sceneId: 'arrival',
      shotId : 'arrival__beat1',
      panels : after.panels,
    });
    expect(placed.saved!.revision.shots).toBeDefined();
    expect(after.panels![0]!.bubbles).toEqual([
      { lineId: lines[0]!, anchor: [0.5, 0.3], tail: [0.4, 0.6] },
    ]);
    // A bubble is outside the prompt, so the shot's drift is as it was
    expect(after.drift).toEqual(keyed.drift);

    expect(await session.setBubbles('arrival', 'arrival__beat1', [])).toMatchObject({ ok: true });
    expect(await session.setPanels('arrival', 'arrival__beat1', [])).toMatchObject({ ok: true });
  });

  it('saves against fresh scene and shot bytes without loading unrelated project inputs', async () => {
    await expect(session.previewBubbles('../arrival', 'arrival__beat1', [])).rejects.toThrow(
      'one scene file',
    );
    const file = p.paths.shotsFile('arrival');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.shots[0].panels = [
      {
        shape: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        framing    : 'medium',
        subjects   : [],
        coversLines: ['arrival:L2'],
      },
    ];
    raw.nextShot = 17;
    raw.externalMetadata = { keep: true };
    raw.shots[0].shotData = { image: 'external-render', extra: 'keep' };
    await fs.writeFile(file, JSON.stringify(raw));
    // A full load would fail parsing this unrelated chunk.
    await fs.writeFile(p.paths.sceneFile('rooftop'), '---\ninvalid: [\n---\n');
    const saved = await session.setBubbles('arrival', 'arrival__beat1', [
      { lineId: 'arrival:L2', anchor: [0.3, 0.4] },
    ]);
    expect(saved.ok).toBe(true);
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    delete persisted.shots[0].panels[0].bubbles;
    expect(persisted).toEqual(raw);
    // Editing the relevant scene is observed immediately, without a watcher event.
    const sceneFile = p.paths.sceneFile('arrival');
    await fs.writeFile(
      sceneFile,
      '---\nscene: arrival\n---\nINT. CLASSROOM - DAY\n\n[[line: L99]]\nA new scene.\n',
    );
    const before = await fs.readFile(file, 'utf8');
    expect(
      await session.setBubbles('arrival', 'arrival__beat1', [
        { lineId: 'arrival:L2', anchor: [0.5, 0.5] },
      ]),
    ).toMatchObject({ ok: false });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it.each(['scene', 'shots'] as const)(
    'refuses an external %s replacement while staging a bubble save',
    async (kind) => {
      const file = p.paths.shotsFile('arrival');
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      raw.shots[0].panels = [
        {
          shape: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          framing    : 'medium',
          subjects   : [],
          coversLines: ['arrival:L2'],
        },
      ];
      const before = JSON.stringify(raw);
      await fs.writeFile(file, before);
      const target = kind === 'scene' ? p.paths.sceneFile('arrival') : file;
      const changed = (await fs.readFile(target, 'utf8')) + '\n';
      const realWrite = fs.writeFile.bind(fs);
      let injected = false;
      const spy = jest.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
        await realWrite(path, data, options);
        if (!injected && String(path).startsWith(file + '.tmp-')) {
          injected = true;
          await realWrite(target, changed);
        }
      });
      try {
        await expect(
          session.setBubbles('arrival', 'arrival__beat1', [
            { lineId: 'arrival:L2', anchor: [0.5, 0.5] },
          ]),
        ).rejects.toThrow('changed while saving');
        expect(injected).toBe(true);
        expect(await fs.readFile(target, 'utf8')).toBe(changed);
        expect(await fs.readFile(file, 'utf8')).toBe(kind === 'shots' ? changed : before);
        expect((await fs.readdir(dirname(file))).some((name) => name.includes('.tmp-'))).toBe(
          false,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  /** The variant control on the strip needs both, and a select built from anything else would
   * offer refusals. */
  it('carries the shot’s variant and the ones it could be moved to', async () => {
    const coverage = await session.sceneCoverage('arrival');
    expect(coverage.shots[0]!.location).toBe('classroom/day');
    expect(coverage.characters).toContain('aiko');
    expect(coverage.variants.length).toBeGreaterThan(0);
  });
});
