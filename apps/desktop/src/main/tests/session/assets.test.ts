import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { ShotsFile } from '@vn/types';
import { WorkspaceSession } from '../../session.js';
import { sessionFor, realPng } from './helpers.js';

/**
 * Adoption from the desktop side: an author who paid for a cleanup hands the file to the pane
 * showing the picture it stands in for, so the slot is read off that asset rather than typed.
 * These cases build their own project, because replacing a plate writes a second `done` for that
 * plate's task and the assertions about which bytes are in the slot only hold on an untouched run.
 */
describe('WorkspaceSession — approving another character’s portrait', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({
      title     : 'Two faces',
      script    : SCRIPTS.linear,
      characters: ['aiko', 'ren'],
    });
    session = sessionFor(p);
    await p.run();
  }, 30_000);

  afterAll(async () => {
    await p.cleanup();
  });

  // The pairing a form can submit: one character's id with another's portrait. Blessing it
  // would seed every sheet and shot drawn for the first character with the second's face.
  it('refuses a portrait that belongs to another character, writing nothing', async () => {
    const [aiko] = await session.gateCandidates('aiko');
    const before = await p.read('characters/ren/character.md');
    const result = await session.approveCharacter('ren', aiko!.hash);
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('not a portrait of ren');
    expect(await p.read('characters/ren/character.md')).toBe(before);
    expect((await session.gateCandidates('aiko'))[0]!.accepted).toBe(false);
  });

  it('refuses a picture that is not a portrait at all', async () => {
    const { store } = await p.reload();
    const plate = store.manifest().find((a) => a.kind === 'location_ref')!;
    const before = await p.read('characters/aiko/character.md');
    expect(await session.approveCharacter('aiko', plate.hash)).toMatchObject({ ok: false });
    expect(await p.read('characters/aiko/character.md')).toBe(before);
  });

  it('locks an approved look against its slot, and only an approved one', async () => {
    expect(await session.lockCharacter('nobody', true)).toMatchObject({ ok: false });
    // Unapproved: nothing for a lock to hold
    expect(await session.gateLockState('ren')).toEqual({ character: true, locked: false });
    expect(await session.lockCharacter('ren', true)).toMatchObject({ ok: false });
    expect(await session.lockCharacter('ren', false)).toMatchObject({ ok: false });

    const [portrait] = await session.gateCandidates('ren');
    expect(await session.approveCharacter('ren', portrait!.hash)).toMatchObject({ ok: true });
    expect(await session.lockCharacter('ren', true)).toMatchObject({
      ok     : true,
      written: ['characters/ren/character.md'],
    });
    expect(await session.gateLockState('ren')).toEqual({
      character: true,
      locked   : true,
      mirror   : portrait!.hash,
    });
    expect(await p.read('characters/ren/character.md')).toContain('status: locked');
    expect(await session.lockCharacter('ren', false)).toMatchObject({ ok: true });
    expect(await p.read('characters/ren/character.md')).toContain('status: approved');
    // Un-approving the locked portrait itself takes the lock with it
    await session.lockCharacter('ren', true);
    await (await p.reload()).store.unaccept(portrait!.hash);
    expect(await p.read('characters/ren/character.md')).toContain('status: candidates');
    expect(await session.lockCharacter('ren', false)).toMatchObject({ ok: false });
  });
});

describe('WorkspaceSession — replacing a picture with a file', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({ title: 'Replaced', script: SCRIPTS.linear });
    session = sessionFor(p);
    await p.run(); // locations render before the gate, so there is a plate to replace
  }, 30_000);

  afterAll(async () => {
    await p.cleanup();
  });

  const plate = async (): Promise<string> => {
    const { store } = await p.reload();
    return store.manifest().find((a) => a.kind === 'location_ref')!.hash;
  };

  it('refuses bytes nothing planned, which is what having no slot means', async () => {
    expect((await session.assetInfo(await plate()))!.slot).toMatch(/^plate:/);

    const drawn = await session.drawConcept('the classroom at dusk', '');
    expect((await session.assetInfo(drawn.hash!))!.slot).toBeUndefined();
    expect(await session.previewReplace(drawn.hash!)).toMatchObject({
      ok     : false,
      message: expect.stringContaining('fills no slot'),
    });
  });

  it('puts an outside file in the plate’s place, and the render it replaced keeps its bytes', async () => {
    const before = await plate();
    const slot = (await session.assetInfo(before))!.slot!;
    expect(await session.previewReplace(before)).toMatchObject({
      ok     : true,
      message: expect.stringContaining('supersed'),
    });

    const file = join(p.dir, 'cleanup.png');
    await fs.writeFile(file, new Uint8Array([...realPng(), 11, 12, 13]));
    const done = await session.replaceAsset(before, file);
    expect(done).toMatchObject({
      ok     : true,
      written: expect.arrayContaining(['vngen/state/tasks.jsonl']),
    });

    // In one act the bytes came in as a reference and left as the plate
    expect(await session.assetInfo(done.hash!)).toMatchObject({ kind: 'location_ref', slot });
    expect((await session.assetInfo(done.hash!))!.newerTake).toBeUndefined();
    // The superseded picture is still there to look at, and only its claim on the slot is gone,
    // which is what makes the strip disappear from its pane. It names what took the slot over, so
    // a pane left on it follows rather than sitting on a picture the project moved past.
    const superseded = (await session.assetInfo(before))!;
    expect(superseded.slot).toBeUndefined();
    expect(superseded.newerTake).toBe(done.hash);
  });

  /**
   * A failure is read off the slot rather than off `asset.sourceTask`, which is what lets the pane
   * report a re-render that never landed. Both records are written by hand, because mock providers
   * always succeed and no run can reach the state these assertions are about.
   */
  it('reports why the slot gave up, and regenerates the render that did', async () => {
    const log = join(p.dir, 'vngen', 'state', 'tasks.jsonl');
    const append = async (record: object): Promise<void> => {
      await fs.appendFile(log, JSON.stringify(record) + '\n');
    };

    const node = (await session.status()).slots.find((s) => s.key.startsWith('plate:') && s.hash)!;
    const shown = (await session.assetInfo(node.hash!))!;
    expect(shown.failure).toBeUndefined();

    // Rewritten from the task's own last record, since the pane derives this asset's prompt from
    // the inputs a hand-written stub would not carry.
    const error = 'the image model returned 503';
    const lines = (await fs.readFile(log, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    const was = lines
      .map((l) => JSON.parse(l) as { hash: string })
      .reverse()
      .find((r) => r.hash === shown.sourceTask)!;
    await append({ ...was, status: 'failed', error, attempts: [{ attempt: 1, refs: [], error }] });
    expect((await session.assetInfo(node.hash!))!.failure).toMatchObject({
      task  : shown.sourceTask,
      status: 'failed',
      error,
      attempts   : 1,
      maxAttempts: 2,
      later      : false,
    });

    // An art-notes edit re-keys the slot, so what the pane reports next is a task these bytes never
    // came from — and the picture on screen is the last one that did.
    const rung = shown.rungs[shown.rungs.length - 1]!.target;
    expect(await session.setArtNotes(rung, 'rain running down the windows')).toMatchObject({
      ok: true,
    });
    const next = (await session.status()).slots.find((s) => s.key === node.key)!.taskHash!;
    expect(next).not.toBe(shown.sourceTask);
    await append({
      hash    : next,
      kind    : 'location_ref',
      deps    : [],
      inputs  : {},
      status  : 'needs_human',
      attempts: [],
      error   : 'the render kept coming back with the wrong window',
    });
    const shownNow = (await session.assetInfo(node.hash!))!;
    expect(shownNow.failure).toMatchObject({ task: next, status: 'needs_human', later: true });

    // These bytes are stale, which is normally refused as an orphan — but the task the orphan
    // refusal would send the author to a run for is the one that just gave up, and no run reaches
    // a task that spent its budget. Regenerating asks for that task rather than this asset's.
    expect(shownNow.stale).toBe(true);
    expect(await session.previewRegenerate(node.hash!)).toMatchObject({
      ok     : true,
      message: expect.stringContaining('gave up'),
    });
    expect(await session.regenerateAsset(node.hash!)).toMatchObject({
      ok     : true,
      message: expect.stringContaining(next.slice(0, 8)),
    });
    // Queued rather than terminal, so the re-render stops being what the pane reports. What it
    // falls back to is the task these bytes came from, which this fixture left `failed` above.
    expect((await session.assetInfo(node.hash!))!.failure).toMatchObject({
      task : shown.sourceTask,
      later: false,
    });
  });
});

/**
 * Putting an older take back. Its own project because it writes two `done` records for one plate's
 * task, and because the assertions are about which of three takes the slot names.
 */
describe('WorkspaceSession — restoring an older take', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({ title: 'Restored', script: SCRIPTS.linear });
    session = sessionFor(p);
    await p.run(); // locations render before the gate, so there is a plate to take over
  }, 30_000);

  afterAll(async () => {
    await p.cleanup();
  });

  const plate = async (): Promise<string> => {
    const { store } = await p.reload();
    return store.manifest().find((a) => a.kind === 'location_ref')!.hash;
  };

  const paint = async (name: string, tail: number[]): Promise<string> => {
    const file = join(p.dir, name);
    await fs.writeFile(file, new Uint8Array([...realPng(), ...tail]));
    return file;
  };

  it('refuses to put back a take that is already the picture in its slot', async () => {
    expect(await session.previewRestore(await plate())).toMatchObject({
      ok     : false,
      message: expect.stringContaining('already the'),
    });
  });

  // Accepting an older take only flips a flag; the slot goes on naming the later render until the
  // take is adopted back onto it, which is the whole of what `asset.restore` adds
  it('puts an older take back, and the take that replaced it becomes the old one', async () => {
    // Twice, because the picture a mock run drew is placeholder art and never becomes real output
    const slot = (await session.assetInfo(await plate()))!.slot!;
    const first = await session.replaceAsset(await plate(), await paint('one.png', [21, 22]));
    const second = await session.replaceAsset(first.hash!, await paint('two.png', [31, 32]));
    expect(second.ok).toBe(true);
    const drawnFrom = (await session.assetInfo(first.hash!))!.prompt;

    expect(await session.previewRestore(first.hash!)).toMatchObject({
      ok     : true,
      message: expect.stringContaining('again'),
    });
    expect(await session.restoreAsset(first.hash!)).toMatchObject({ ok: true });

    const back = (await session.assetInfo(first.hash!))!;
    expect(back.slot).toBe(slot);
    expect(back.newerTake).toBeUndefined();
    expect(back).toMatchObject({ current: true, accepted: true, approved: true });
    // Put back keeps the row's own account of how it first arrived; only the hold time moves.
    expect(back.via).toBe('upload');
    // The picture is still the one it always was, so it goes on reporting the drift it really has
    expect(back.prompt).toBe(drawnFrom);
    // And the file that had taken the slot is now the older take, pointing back at this one. An
    // adoption holds without approving, so it was never accepted and is not now.
    expect(await session.assetInfo(second.hash!)).toMatchObject({
      newerTake: first.hash,
      current  : false,
      accepted : false,
      approved : false,
    });
  });
});

/**
 * Approving an older portrait at the gate makes it the slot's take for good. The hold alone does not
 * last: every load runs `repairCurrent`, which rewrites `current` to the output the task log names.
 */
describe('WorkspaceSession — approving an older portrait', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({ title: 'Older look', script: SCRIPTS.linear });
    session = sessionFor(p);
    await p.run(); // the first portrait; halts at the gate
  }, 30_000);

  afterAll(async () => {
    await p.cleanup();
  });

  const portraits = async (): Promise<string[]> => {
    const { store } = await p.reload();
    return store
      .manifest()
      .filter((a) => a.kind === 'portrait')
      .map((a) => a.hash);
  };

  it('holds the older take through a reload, a run and the playable', async () => {
    const [first] = await portraits();
    expect(await session.setArtNotes('character:aiko', 'freckles')).toMatchObject({ ok: true });
    await p.run(); // a second draft takes the slot
    const second = (await portraits()).find((h) => h !== first)!;
    expect(await session.assetInfo(second)).toMatchObject({ current: true });

    const approved = await session.approveCharacter('aiko', first!);
    expect(approved).toMatchObject({ ok: true });

    expect(await session.assetInfo(first!)).toMatchObject({
      current : true,
      accepted: true,
      approved: true,
    });
    expect(await session.assetInfo(second)).toMatchObject({ current: false, accepted: false });
    expect((await session.status()).blockedOnGate).toBe(false);
    expect((await session.playable()).characters['aiko']!.portrait).toMatchObject({
      hash: first,
    });
    // The slot's task is logged done with the older take, which is what keeps it held
    expect(approved.written).toContain('vngen/state/tasks.jsonl');

    // The next run draws downstream of the approved take, not a third portrait over it
    await p.run();
    expect(await portraits()).toHaveLength(2);
    expect(await session.assetInfo(first!)).toMatchObject({ current: true, approved: true });
  }, 60_000);
});

/**
 * A frame replaced across the two roots: the upload stays a `reference` in the base root while the
 * project root files the same bytes as the frame, and the frame is the row every surface must see.
 */
describe('WorkspaceSession — replacing a frame with a file', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({ title: 'Reframed', script: SCRIPTS.linear });
    session = sessionFor(p);
    await p.run();
    await p.approveAll();
    await p.run(); // the gate is clear, so every shot has a frame
  }, 30_000);

  afterAll(async () => {
    await p.cleanup();
  });

  it('files the upload as the frame, which its slot can then accept and the playable shows', async () => {
    const shots = JSON.parse(await p.read('vngen/work/shots/arrival.json')) as ShotsFile;
    const shotId = shots.shots[0]!.id;
    const rendered = shots.shots[0]!.shotData!.image!;
    expect((await session.assetInfo(rendered))!.slot).toBe(`shot:arrival/${shotId}`);

    const file = join(p.dir, 'repaint.png');
    await fs.writeFile(file, new Uint8Array([...realPng(), 41, 42]));
    const done = await session.replaceAsset(rendered, file);
    expect(done.ok).toBe(true);

    // The merged manifest answers with the frame, not the upload it came in as
    const info = (await session.assetInfo(done.hash!))!;
    expect(info).toMatchObject({ kind: 'shot_image', slot: `shot:arrival/${shotId}` });
    // Upstream first, as the popup would: a frame is accepted only once its plate and sheets are
    for (const prereq of info.prereqs.filter((q) => !q.approved)) {
      expect(await session.acceptAsset(prereq.hash)).toMatchObject({ ok: true });
    }
    expect(await session.previewAccept(done.hash!)).toMatchObject({ ok: true });
    expect(await session.acceptAsset(done.hash!)).toMatchObject({ ok: true });

    const play = await session.playable();
    const frames = play.scenes['arrival']!.beats.filter((b) => b.type === 'show');
    expect(frames[0]).toMatchObject({ type: 'show', image: { hash: done.hash } });
  });
});
