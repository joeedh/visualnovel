import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { logTask } from '@vn/taskgraph/write';
import { WorkspaceSession } from '../../session.js';
import { sessionFor, realPng } from './helpers.js';

describe('WorkspaceSession — over a generated project', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({ title: 'Generated', script: SCRIPTS.linear });
    session = sessionFor(p);
    await p.run(); // locations + portraits; halts at the gate
  }, 30_000);

  afterAll(async () => {
    await p.cleanup();
  });

  it('approves a portrait through the gate, clearing it', async () => {
    const candidates = await session.gateCandidates('aiko');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.accepted).toBe(false);

    const result = await session.approveCharacter('aiko', candidates[0]!.hash);
    expect(result.ok).toBe(true);
    expect(await p.read('characters/aiko/character.md')).toContain('status: approved');
    expect((await session.status()).blockedOnGate).toBe(false);
    // The gate holds as well as accepts, so the approved draft is the slot's current take.
    expect(await session.assetInfo(candidates[0]!.hash)).toMatchObject({
      current : true,
      accepted: true,
      approved: true,
    });

    await p.run(); // the gate is clear: model sheets + the remaining shots render
    expect((await session.status()).tasks.every((t) => t.status === 'done')).toBe(true);
  }, 30_000);

  it('draws one slot: a drawn plate is requeued and named as the one task to run', async () => {
    const slot = 'plate:rooftop/evening';
    expect(await session.previewDraw(slot)).toMatchObject({ ok: true });
    const queued = await session.drawSlot(slot);
    expect(queued).toMatchObject({ ok: true, written: ['vngen/state/tasks.jsonl'] });
    const task = (await session.status()).tasks.find((t) => t.hash === queued.task);
    expect(task).toMatchObject({ kind: 'location_ref', status: 'pending' });
    // Already pending, so a second draw has nothing to requeue and writes nothing
    expect(await session.drawSlot(slot)).toMatchObject({ ok: true, written: [] });
    expect(await session.previewDraw('nonsense')).toMatchObject({ ok: false });
  });

  it('resumes an abandoned slot while refusing the version owned by a live run', async () => {
    const { graph } = await p.reload();
    const task = graph
      .all()
      .find(
        (t) =>
          t.kind === 'location_ref' &&
          'locationId' in t.inputs &&
          t.inputs.locationId === 'rooftop',
      )!;
    const original = { ...task };
    try {
      task.status = 'running';
      await logTask(p.paths, task);
      const before = await p.read('vngen/state/tasks.jsonl');
      expect((await session.status()).tasks.find((t) => t.hash === task.hash)).toMatchObject({
        status     : 'pending',
        interrupted: true,
      });
      expect(await session.previewDraw('plate:rooftop/evening')).toMatchObject({ ok: true });
      expect(await session.drawSlot('plate:rooftop/evening')).toMatchObject({
        ok     : true,
        written: [],
      });
      expect(await p.read('vngen/state/tasks.jsonl')).toBe(before);
      session.progress.activity = { [task.hash]: 'drawing' };
      expect((await session.status()).tasks.find((t) => t.hash === task.hash)?.status).toBe(
        'running',
      );
      expect(await session.previewDraw('plate:rooftop/evening')).toMatchObject({
        ok     : false,
        message: expect.stringContaining('being drawn now'),
      });
    } finally {
      session.progress.activity = {};
      await logTask(p.paths, original);
    }
  });

  it('rejects an approval for a hash the store does not hold', async () => {
    const result = await session.approveCharacter('aiko', 'not-a-real-hash');
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('not-a-real-hash');
  });

  it('resolves generated art into the playable and exports it', async () => {
    const play = await session.playable();
    expect(play.characters['aiko']!.portrait).toBeDefined();
    const show = play.scenes['arrival']!.beats.find((b) => b.type === 'show');
    expect(show).toMatchObject({ type: 'show', image: { ext: 'png' } });

    // The player builds with unapproved frames; exporting them is what is refused, and the
    // check's sentence is the run's.
    const refusal = await session.exportRefusal();
    expect(refusal).toMatch(/^shot:arrival\/\S+ holds a take nobody has approved/);
    await expect(session.exportPlayable()).rejects.toMatchObject({
      code   : 'UNAPPROVED',
      message: refusal,
    });
  });

  /**
   * Asserts the whole claim of `story.moveShot`: the order of `show` beats changes, and both
   * frames still resolve to the images the run already paid for.
   */
  it('reorders a shot by moving its lines, and the playable follows without re-rendering', async () => {
    const before = (await session.playable()).scenes['arrival']!.beats;
    expect(before.map((b) => b.type)).toEqual(['show', 'narrate', 'show', 'say']);

    const result = await session.editScene(
      await session.shotOrder('arrival', 'arrival__beat1', ''),
    );
    expect(result).toMatchObject({ ok: true, written: ['scenes/arrival.md'] });
    expect(result.message).toContain('nothing drifts');

    const after = (await session.playable()).scenes['arrival']!.beats;
    expect(after.map((b) => b.type)).toEqual(['show', 'say', 'show', 'narrate']);
    expect(after.filter((b) => b.type === 'show')).toEqual(
      [...before.filter((b) => b.type === 'show')].reverse(),
    );
    expect((await session.sceneCoverage('arrival')).shots.map((s) => s.drift)).toEqual([
      'current',
      'current',
    ]);
  });

  /** The classroom plate the following assertions are about. */
  const plate = async (): Promise<string> => {
    const { store } = await p.reload();
    const found = store
      .manifest()
      .find((a) => a.kind === 'location_ref' && a.satisfies[0]?.locationId === 'classroom');
    return found!.hash;
  };

  it('describes a plate: what to call it, what made it, and which rungs reach it', async () => {
    const info = await session.assetInfo(await plate());
    expect(info).toMatchObject({ kind: 'location_ref', base: true, stale: false });
    expect(info!.label).toBe('Classroom — day');
    // Nothing has been edited yet, so the bytes and the builders still say the same words.
    expect(info!.derived).toBe(info!.prompt);
    expect(info!.rungs.map((r) => r.target)).toEqual([
      'location:classroom',
      'location:classroom/day',
    ]);
    expect(info!.rungs.every((r) => r.notes === undefined)).toBe(true);
    expect(await session.assetInfo('not-a-real-hash')).toBeNull();
  });

  it('accepts a plate, and refuses a hash the store does not hold', async () => {
    const hash = await plate();
    expect(await session.acceptAsset(hash)).toMatchObject({ ok: true });
    expect((await session.assetInfo(hash))!.accepted).toBe(true);
    expect(await session.acceptAsset('not-a-real-hash')).toMatchObject({ ok: false });
  });

  // A precondition check only produces a sentence a surface may show; the act itself may not
  // rely on it as a gate. `exec` re-decides for itself, so this test checks that the refusal
  // happens at the point where the write occurs.
  it('refuses a portrait and a concept in the act, not only in the check', async () => {
    const { store } = await p.reload();
    const portrait = store.manifest().find((a) => a.kind === 'portrait')!.hash;
    // A portrait in this project may already be accepted because the gate ran, so the refusal has
    // to leave that state as it found it.
    const before = (await session.assetInfo(portrait))!.accepted;
    expect(await session.previewAccept(portrait)).toMatchObject({ ok: false });
    expect(await session.acceptAsset(portrait)).toMatchObject({ ok: false });
    expect((await session.assetInfo(portrait))!.accepted).toBe(before);

    const drawn = await session.drawConcept('the classroom at dusk', '');
    expect(drawn).toMatchObject({ ok: true });
    const refused = await session.acceptAsset(drawn.hash!);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.message).toContain('art.promote');
    expect((await session.assetInfo(drawn.hash!))!.accepted).toBe(false);
  });

  it('queues a plate for re-run by putting its own task back to pending', async () => {
    const hash = await plate();
    const info = (await session.assetInfo(hash))!;
    expect(await session.previewRegenerate(hash)).toMatchObject({ ok: true });

    const queued = await session.regenerateAsset(hash);
    expect(queued).toMatchObject({ ok: true, written: ['vngen/state/tasks.jsonl'] });
    const task = (await session.status()).tasks.find((t) => t.hash === info.sourceTask);
    expect(task).toMatchObject({ status: 'pending' });
  });

  it('writes art notes on one variant, and the plate that predates them goes stale', async () => {
    const notes = 'sodium streetlight raking across the formwork';
    expect(await session.previewArtNotes('location:classroom/day', notes)).toMatchObject({
      ok: true,
    });
    expect(await session.setArtNotes('location:classroom/day', notes)).toMatchObject({
      ok     : true,
      written: ['locations/classroom.md'],
    });
    expect(await p.read('locations/classroom.md')).toContain(`art_notes: ${notes}`);

    const info = (await session.assetInfo(await plate()))!;
    expect(info.stale).toBe(true);
    expect(info.derived).toContain(notes);
    expect(info.rungs.find((r) => r.target === 'location:classroom/day')!.notes).toBe(notes);
    // The task that made those bytes is now an orphan. The planner wants a different hash, so
    // re-running it would buy back the picture the author just edited away from.
    expect(await session.previewRegenerate(info.hash)).toMatchObject({ ok: false });
  });

  /**
   * A P7 refine attempt appends a `Corrections:` clause no derivation reproduces, so comparing the
   * recorded prompt verbatim made every refined frame permanently stale — and permanently refused
   * for regeneration, with a refusal telling the author to run a pipeline that plans nothing.
   */
  it('does not count a refine attempt as drift, and still catches an edit on top of one', async () => {
    const hash = await plate();
    const manifestFile = join(p.dir, 'assets', 'manifest.json');
    const patch = async (prompt: string): Promise<void> => {
      const file = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as {
        assets: { hash: string; prompt?: string }[];
      };
      file.assets.find((a) => a.hash === hash)!.prompt = prompt;
      await fs.writeFile(manifestFile, JSON.stringify(file, null, 2) + '\n');
    };

    const derived = (await session.assetInfo(hash))!.derived!;
    await patch(`${derived} Corrections: fix the lighting.`);
    const refined = (await session.assetInfo(hash))!;
    expect(refined.stale).toBe(false);
    // The editor still shows what was sent; only the comparison is normalized.
    expect(refined.prompt).toContain('Corrections: fix the lighting.');
    expect(await session.previewRegenerate(hash)).toMatchObject({ ok: true });

    expect(
      await session.setArtNotes('location:classroom/day', 'chalk dust in the air'),
    ).toMatchObject({ ok: true });
    expect((await session.assetInfo(hash))!.stale).toBe(true);
    expect(await session.previewRegenerate(hash)).toMatchObject({ ok: false });
  });

  it('writes a seed on the same rung, and offers the config seed as what it inherits', async () => {
    expect(await session.previewArtSeed('location:classroom/day', 12)).toMatchObject({ ok: true });
    expect(await session.setArtSeed('location:classroom/day', 12)).toMatchObject({
      ok     : true,
      written: ['locations/classroom.md'],
    });
    expect(await p.read('locations/classroom.md')).toContain('seed: 12');
    const info = (await session.assetInfo(await plate()))!;
    expect(info.rungs.find((r) => r.target === 'location:classroom/day')!.seed).toBe(12);

    // `null` is the only clear, because a seed of 0 is one an author chose
    expect(await session.setArtSeed('location:classroom/day', null)).toMatchObject({ ok: true });
    expect(await p.read('locations/classroom.md')).not.toContain('seed:');
  });

  it('writes an image model on a rung, reads it back on the asset, and clears it with an empty id', async () => {
    expect(await session.previewArtModel('location:classroom/day', 'other-image')).toMatchObject({
      ok: true,
    });
    expect(await session.setArtModel('location:classroom/day', 'other-image')).toMatchObject({
      ok     : true,
      written: ['locations/classroom.md'],
    });
    expect(await p.read('locations/classroom.md')).toContain('image_model: other-image');
    const info = (await session.assetInfo(await plate()))!;
    expect(info.rungs.find((r) => r.target === 'location:classroom/day')!.imageModel).toBe(
      'other-image',
    );
    expect(info.projectModel).toBe('gemini-2.5-flash-image');

    expect(await session.setArtModel('location:classroom/day', '')).toMatchObject({ ok: true });
    expect(await p.read('locations/classroom.md')).not.toContain('image_model:');
    expect(await session.setArtModel('character:nobody', 'x')).toMatchObject({
      ok     : false,
      written: [],
    });
  });

  it('refuses a seed an image backend cannot take, and a rung that is not there', async () => {
    expect(await session.previewArtSeed('location:classroom/day', -3)).toMatchObject({ ok: false });
    expect(await session.previewArtSeed('location:classroom/midnight', 1)).toMatchObject({
      ok: false,
    });
    expect(await session.setArtSeed('character:nobody', 1)).toMatchObject({
      ok     : false,
      written: [],
    });
  });

  it('refuses a rung that does not exist rather than creating one, and writes nothing', async () => {
    expect(await session.previewArtNotes('location:classroom/midnight', 'x')).toMatchObject({
      ok: false,
    });
    expect(await session.previewArtNotes('a location', 'x')).toMatchObject({ ok: false });
    expect(await session.setArtNotes('character:nobody', 'x')).toMatchObject({
      ok     : false,
      written: [],
    });
  });

  /**
   * Covers §15 through the session rather than through `@vn/artgen`: outside bytes come in, get
   * attached to a clause, and come off again. An upload is the one reference that pins itself, so
   * it also proves `from` is optional the whole way down.
   */
  it('uploads an image, attaches it to a clause, and takes it off again', async () => {
    const file = join(p.dir, 'moodboard.png');
    await fs.writeFile(file, realPng());
    expect(await session.previewUpload(file, 'Moodboard')).toMatchObject({ ok: true });

    const up = await session.uploadAsset(file, 'Moodboard');
    expect(up).toMatchObject({ ok: true });
    const upload = (await session.assetInfo(up.hash!))!;
    expect(upload.kind).toBe('reference');
    expect(upload.accepted).toBe(false);
    // Nothing generated the upload, so there is no work to bless; the concept refusal mirrors this
    expect(await session.previewAccept(upload.hash)).toMatchObject({ ok: false });
    expect((await session.acceptAsset(upload.hash)).message).toContain('prompt.addRef');

    const target = await plate();
    const chunk = (await session.promptView(target))!.chunks[0]!.key;
    expect(await session.previewAddRef(target, chunk, up.hash!)).toMatchObject({ ok: true });
    expect(await session.addPromptRef(target, chunk, up.hash!)).toMatchObject({ ok: true });

    const attached = (await session.promptView(target))!.chunks.find((c) => c.key === chunk)!;
    expect(attached.refs).toEqual([
      { pin: up.hash, ext: 'png', label: expect.stringContaining('Moodboard') },
    ]);

    // A prefix addresses the reference, the way an author reads one off the screen
    expect(await session.dropPromptRef(target, chunk, up.hash!.slice(0, 8))).toMatchObject({
      ok: true,
    });
    expect((await session.promptView(target))!.chunks.find((c) => c.key === chunk)!.refs).toBe(
      undefined,
    );
  });

  it('refuses an address that names no slot, and one that names an empty one', async () => {
    const target = await plate();
    const chunk = (await session.promptView(target))!.chunks[0]!.key;
    const nonsense = await session.previewAddRef(target, chunk, 'a picture of a cat');
    expect(nonsense).toMatchObject({ ok: false });
    expect(nonsense.message).toContain('plate:<location>/<variant>');
    expect(await session.previewAddRef(target, chunk, 'plate:nowhere/night')).toMatchObject({
      ok: false,
    });
  });

  /**
   * What the agent's `approve_assets` is allowed to reach. The list is the project's answer rather
   * than the agent's, so the two things worth pinning are that nothing already blessed is on it and
   * that approving through it is the same act as approving by hand.
   */
  it('lists what is waiting for approval, and approves one through its own door', async () => {
    const waiting = await session.approvable();
    expect(waiting.length).toBeGreaterThan(0);
    // A concept is left out, because the pipeline never asked for it and nothing waits on it
    expect(waiting.some((a) => a.kind === 'concept')).toBe(false);
    for (const row of waiting) {
      // The name the author would read, not the hash, and the door that matches the kind.
      expect(row.label).not.toBe(row.hash);
      expect(row.door).toBe(row.kind === 'portrait' ? 'gate' : 'accept');
      if (row.door === 'accept') expect((await session.assetInfo(row.hash))!.accepted).toBe(false);
    }

    const ready = waiting.find((a) => a.door === 'accept' && !a.blocked);
    expect(ready).toBeDefined();
    expect(await session.approveOne(ready!)).toMatchObject({ ok: true });
    expect((await session.assetInfo(ready!.hash))!.accepted).toBe(true);
    expect((await session.approvable()).map((a) => a.hash)).not.toContain(ready!.hash);
  });

  // The list is one row per slot: the take it holds. A take a later render pushed out is not
  // waiting on anything, and accepting it outright is refused in favour of `asset.restore`.
  it('lists only the take a slot holds, and refuses to accept one it does not', async () => {
    const { store } = await p.reload();
    const plate = store.manifest().find((a) => a.kind === 'location_ref' && a.current)!;
    const older = await store.write(new TextEncoder().encode('an older plate'), 'png', {
      kind      : 'location_ref',
      sourceTask: plate.sourceTask,
      modelId   : plate.modelId,
      satisfies : plate.satisfies[0]!,
    });
    const waiting = await session.approvable();
    expect(waiting.map((a) => a.hash)).not.toContain(older.hash);
    const refused = await session.previewAccept(older.hash);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.message).toContain('asset.restore');
    expect((await session.assetInfo(older.hash))!.newerTake).toBe(plate.hash);
  });

  // Last in this block, because accepting every take empties the approval list the tests above
  // read. The older plate written above is not current, so `acceptAll` leaves it alone.
  it('exports once every take the playable shows is accepted', async () => {
    const play = await session.playable();
    expect((await p.acceptAll()).length).toBeGreaterThan(0);
    expect(await session.exportRefusal()).toBeUndefined();
    const { path, scenes } = await session.exportPlayable();
    expect(scenes).toBe(2);
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual(play);
  });
});
