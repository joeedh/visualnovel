/**
 * `WorkspaceSession` is the main-process join point every `story.*` / `gate.*` / `pipeline.*`
 * command routes through. It is Electron-free by construction, so it can be driven directly
 * over a real generated project — testkit runs the pipeline, the session reads it back.
 */
import { promises as fs } from 'node:fs';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { WorkspaceSession, type SessionDeps } from '../session.js';
import { setChoice, setNext, spliceScene } from '../../shared/branchops.js';

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

/** The Wave 3 write path: `storyGraph` reads the wiring, `editBranches` rewires it. */
describe('WorkspaceSession — branch editing', () => {
  const SCRIPT = 'screenplay/script.fountain';
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ title: 'Branches', script: SCRIPTS.diamond });
    session = sessionFor(p);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it('derives scenes, stable edge ids and reachability from the model', async () => {
    const graph = await session.storyGraph();
    expect(graph.start).toBe('arrival');
    expect(graph.scenes.map((s) => s.id)).toEqual(['arrival', 'greet', 'observe', 'rooftop']);
    expect(graph.edges.map((e) => e.id)).toEqual([
      'arrival#choice:0',
      'arrival#choice:1',
      'greet#next',
      'observe#next',
    ]);
    expect(graph.edges[0]).toMatchObject({
      from: 'arrival',
      to: 'greet',
      kind: 'choice',
      label: 'Speak up',
      index: 0,
      dangling: false,
    });
    expect(graph.scenes.every((s) => s.reachable)).toBe(true);
  });

  it('marks an unreachable scene rather than dropping it', async () => {
    const orphaned = await makeProject({ title: 'Orphan', script: SCRIPTS.orphan });
    try {
      const graph = await sessionFor(orphaned).storyGraph();
      expect(graph.scenes.find((s) => s.id === 'forgotten')?.reachable).toBe(false);
      expect(graph.diagnostics.some((d) => d.where === 'forgotten')).toBe(true);
    } finally {
      await orphaned.cleanup();
    }
  });

  it('writes only marker lines, and reports the file it wrote', async () => {
    const before = await p.read(SCRIPT);
    const result = await session.editBranches((scenes) =>
      setNext(scenes, { scene: 'rooftop', goto: 'arrival' }),
    );

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([SCRIPT]);
    const after = await p.read(SCRIPT);
    const markerless = (text: string): string[] =>
      text.split('\n').filter((l) => !/^\s*\[\[(choice|next):/.test(l));
    expect(markerless(after)).toEqual(markerless(before));
    // A cycle back to the entry scene is legal; the model just picks it up.
    expect((await session.storyGraph()).edges.map((e) => e.id)).toContain('rooftop#next');
  });

  it('rebuilds reachability after the edit, so a cut branch goes dark', async () => {
    const result = await session.editBranches((scenes) =>
      setChoice(scenes, { scene: 'arrival', goto: 'greet', label: 'Speak up', index: 1 }),
    );
    const dark = result.graph?.scenes.filter((s) => !s.reachable).map((s) => s.id);
    expect(dark).toEqual(['observe']);
  });

  it('refuses a rewire without touching the file', async () => {
    const before = await p.read(SCRIPT);
    const result = await session.editBranches((scenes) =>
      spliceScene(scenes, { scene: 'arrival', from: 'greet' }),
    );
    expect(result).toMatchObject({ ok: false, written: [] });
    expect(result.message).toContain('already forks');
    expect(await p.read(SCRIPT)).toBe(before);
  });

  it('reports a rewire that was already in place as writing nothing', async () => {
    const result = await session.editBranches((scenes) =>
      setNext(scenes, { scene: 'greet', goto: 'rooftop' }),
    );
    expect(result.ok).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.message).toContain('nothing written');
  });

  it('splices a scene into a choice edge as one patch', async () => {
    const result = await session.editBranches((scenes) =>
      spliceScene(scenes, { scene: 'rooftop', from: 'arrival', edge: 0 }),
    );
    expect(result.ok).toBe(true);

    const edges = result.graph?.edges ?? [];
    // The decision keeps its label; only its first stop moved. rooftop then leads to greet.
    expect(edges.find((e) => e.id === 'arrival#choice:0')).toMatchObject({
      to: 'rooftop',
      label: 'Speak up',
    });
    expect(edges.find((e) => e.id === 'rooftop#next')).toMatchObject({ to: 'greet' });
    expect(result.graph?.scenes.every((s) => s.reachable)).toBe(true);
  });

  it('flags a next on a forking scene as inert instead of hiding it', async () => {
    const result = await session.editBranches((scenes) =>
      setNext(scenes, { scene: 'arrival', goto: 'rooftop' }),
    );
    const next = result.graph?.edges.find((e) => e.id === 'arrival#next');
    expect(next).toMatchObject({ to: 'rooftop', inert: true });
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
