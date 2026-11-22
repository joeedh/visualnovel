import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { WorkspaceSession } from '../../session.js';
import { sessionFor } from './helpers.js';

describe('WorkspaceSession — reading a project', () => {
  let p: TestProject;

  beforeAll(async () => {
    p = await makeProject({ title: 'Session', script: SCRIPTS.linear });
  });

  afterAll(async () => {
    await p.cleanup();
  });

  it('indexes the workspace', async () => {
    const index = await sessionFor(p).index();
    expect(index.title).toBe('Session');
    expect(index.entry).toBe('arrival');
    expect(index.characters.map((c) => c.id)).toEqual(['aiko']);
    expect(index.scenes.map((s) => s.id)).toEqual(['arrival', 'rooftop']);
  });

  it('reports the gate as blocking before anything is generated', async () => {
    const status = await sessionFor(p).status();
    expect(status.blockedOnGate).toBe(true);
    expect(status.gatePending).toEqual(['aiko']);
    expect(status.tasks).toEqual([]);
  });

  it('treats a mock pipeline run as a dry run', async () => {
    const result = await sessionFor(p).runPipeline(true);
    expect(result.ran).toBe(0);
    expect(result.preview.pendingTasks).toBeGreaterThan(0);
    expect((await p.reload()).store.manifest()).toHaveLength(0);
  });

  // `workspace.open` refuses to replace a session with work in flight
  it('names the work in flight from the call, not from when the scheduler starts', async () => {
    const session = sessionFor(p);
    expect(session.busy()).toBeUndefined();

    const running = session.runPipeline(true);
    expect(session.busy()).toBe('a pipeline run');
    await running;
    expect(session.busy()).toBeUndefined();
  });

  // Stop reaches a pass between its rounds, which is where approving happens and where nothing
  // used to be in flight to receive it.
  it('holds the session for a whole pass, and carries a stop across a round boundary', async () => {
    const session = sessionFor(p);
    const seen: (string | undefined)[] = [];

    await session.duringPass(async (signal) => {
      await session.runPipeline(true);
      // A run inside a pass reports the pass, since that is what a second run would collide with
      seen.push(session.busy());
      expect(signal.aborted).toBe(false);

      // The run made no controller of its own, so its ending did not clear the pass's: a stop
      // asked for here — between rounds, with nothing in flight — still lands.
      expect(session.stopPipeline()).toBe(true);
      expect(signal.aborted).toBe(true);
    });

    expect(seen).toEqual(['an approve-and-generate pass']);
    expect(session.busy()).toBeUndefined();
    expect(session.stopPipeline()).toBe(false);
  });

  it('builds a playable with no asset refs while nothing is generated', async () => {
    const play = await sessionFor(p).playable();
    expect(play.start).toBe('arrival');
    expect(play.characters['aiko']!.portrait).toBeUndefined();
    // The session reads this off `project.yaml`. A build that skips it leaves the runner staging
    // portraits nobody asked for.
    expect(play.portraitOverlay).toBe(false);
  });
});

/**
 * `workspace.import` and `story.screenplay` are the migration into the chunk form and the way back
 * out of it. The import is asserted by what the model says afterwards. A conversion that lost or
 * renamed a scene would detach its shots, so "same graph" is the contract, not "same bytes".
 */
describe('WorkspaceSession — Fountain in and out', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  const has = async (rel: string): Promise<boolean> =>
    await fs
      .access(join(p.dir, rel))
      .then(() => true)
      .catch(() => false);

  afterEach(async () => {
    await p.cleanup();
  });

  it('imports a screenplay project into chunks with the same graph', async () => {
    p = await makeProject({ title: 'Import', script: SCRIPTS.diamond, format: 'screenplay' });
    session = sessionFor(p);
    // Before the import the screenplay builds nothing, so the graph is empty and says why
    const before = await session.storyGraph();
    expect(before.scenes).toEqual([]);
    expect(before.diagnostics.map((d) => d.code)).toEqual(['legacy_screenplay']);

    const preview = await session.previewImport();
    expect(preview).toMatchObject({ ok: true });
    expect(preview.message).toContain('4 scene(s) would move');
    expect(await has('scenes/arrival.md')).toBe(false);

    const result = await session.importScreenplay();
    expect(result.ok).toBe(true);
    expect(result.written).toEqual([
      'scenes/arrival.md',
      'scenes/greet.md',
      'scenes/observe.md',
      'scenes/rooftop.md',
      'project.yaml',
      'screenplay/script.fountain.imported',
    ]);
    // The screenplay stops being a `.fountain` — otherwise every load keeps reporting it.
    expect(await has('screenplay/script.fountain')).toBe(false);
    expect(await has('screenplay/script.fountain.imported')).toBe(true);
    // A directory has no document order, so the entry has to be written down.
    expect(await p.read('project.yaml')).toContain('start: arrival');

    // The import produces the same graph as the same story authored as chunks
    const after = await session.storyGraph();
    const authored = await makeProject({ title: 'Import', script: SCRIPTS.diamond });
    try {
      const expected = await sessionFor(authored).storyGraph();
      expect(after.scenes).toEqual(expected.scenes);
      expect(after.edges).toEqual(expected.edges);
      expect(after.diagnostics).toEqual([]);
    } finally {
      await authored.cleanup();
    }
  });

  it('refuses to import over chunks that already exist, and over nothing to import', async () => {
    p = await makeProject({ title: 'No import', script: SCRIPTS.linear, format: 'chunks' });
    session = sessionFor(p);

    const preview = await session.previewImport();
    expect(preview.ok).toBe(false);
    expect(preview.message).toContain('already holds 2 chunk(s)');
    expect(await session.importScreenplay()).toMatchObject({ ok: false, written: [] });

    // With the chunks removed there is no screenplay either, which refuses from the other side
    await fs.rm(join(p.dir, 'scenes'), { recursive: true });
    expect(await session.previewImport()).toMatchObject({
      ok     : false,
      message: 'There is no screenplay/*.fountain to import.',
    });
  });

  it('writes the screenplay back out, at the root and never into screenplay/', async () => {
    p = await makeProject({ title: 'Screenplay', script: SCRIPTS.diamond, format: 'chunks' });
    session = sessionFor(p);

    const result = await session.writeScreenplay(false);
    expect(result).toMatchObject({ ok: true, written: ['screenplay.fountain'] });
    expect(result.message).toContain('4 scene(s)');
    expect(await has('screenplay/script.fountain')).toBe(false);

    const text = await p.read('screenplay.fountain');
    expect(text).toContain('[[choice: "Speak up" -> greet]]');
    expect(text).toContain('[[line: L1]]');

    // Clean output is a reading copy, so the ids and the branches go with the markers
    const clean = await session.writeScreenplay(true);
    expect(clean.message).toContain('cannot be imported back');
    expect(await p.read('screenplay.fountain')).not.toContain('[[');
  });
});
