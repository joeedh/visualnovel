/**
 * `WorkspaceSession` is the main-process join point every `story.*` / `gate.*` / `pipeline.*`
 * command routes through. It is Electron-free by construction, so it can be driven directly
 * over a real generated project — testkit runs the pipeline, the session reads it back.
 */
import { promises as fs } from 'node:fs';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent: () => {},
  requestPlan: () => Promise.resolve({ approved: false }),
};

const sessionFor = (p: TestProject) => new WorkspaceSession(p.dir, true, deps);

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

  it('builds a playable with no asset refs while nothing is generated', async () => {
    const play = await sessionFor(p).playable();
    expect(play.start).toBe('arrival');
    expect(play.characters['aiko']!.portrait).toBeUndefined();
  });
});

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

    await p.run(); // the gate is clear: model sheets + the remaining shots render
    expect((await session.status()).tasks.every((t) => t.status === 'done')).toBe(true);
  }, 30_000);

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

    const { path, scenes } = await session.exportPlayable();
    expect(scenes).toBe(2);
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual(play);
  });
});
