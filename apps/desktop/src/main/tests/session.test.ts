/**
 * `WorkspaceSession` is the main-process join point every `story.*` / `gate.*` / `pipeline.*`
 * command routes through. It is Electron-free by construction, so it can be driven directly
 * over a real generated project — testkit runs the pipeline, the session reads it back.
 */
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
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

/**
 * The Wave 3 write path: `storyGraph` reads the wiring, `editBranches` rewires it. Pinned to the
 * one-screenplay form, where every scene shares a file — the per-chunk form is asserted below.
 */
describe('WorkspaceSession — branch editing', () => {
  const SCRIPT = 'screenplay/script.fountain';
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ title: 'Branches', script: SCRIPTS.diamond, format: 'screenplay' });
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

/**
 * `story.assignLineIds`: the ids reading allocated, written down so an insertion can't move them.
 * Also on the screenplay form — a script written as one file is what has no marks to begin with.
 */
describe('WorkspaceSession — line ids', () => {
  const SCRIPT = 'screenplay/script.fountain';
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ title: 'Line ids', script: SCRIPTS.linear, format: 'screenplay' });
    session = sessionFor(p);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  const lineIds = async (scene: string) =>
    (await session.sceneCoverage(scene)).lines.map((l) => l.id);

  it('previews the marks without writing any', async () => {
    const before = await p.read(SCRIPT);
    const preview = await session.previewLineIds();
    expect(preview.ok).toBe(true);
    expect(preview.assigned).toBeGreaterThan(0);
    expect(await p.read(SCRIPT)).toBe(before);
  });

  it('writes the ids reading already allocated, changing none of them', async () => {
    const before = await lineIds('arrival');
    const result = await session.writeLineIds();
    expect(result).toMatchObject({ ok: true, written: [SCRIPT] });
    expect(await lineIds('arrival')).toEqual(before);
    expect(await p.read(SCRIPT)).toContain('[[line: L1]]');
  });

  it('is a no-op the second time, and says so', async () => {
    await session.writeLineIds();
    const text = await p.read(SCRIPT);
    const again = await session.writeLineIds();
    expect(again).toMatchObject({ ok: true, written: [] });
    expect(again.message).toContain('already carries its id');
    expect(await p.read(SCRIPT)).toBe(text);
  });

  it('scopes to one scene, and holds ids still when a line is inserted above them', async () => {
    // The whole point of the plan: with marks written, an insertion allocates a fresh id
    // instead of shifting every id below it onto different prose.
    await session.writeLineIds('arrival');
    const before = await lineIds('arrival');

    const text = await p.read(SCRIPT);
    await p.write(SCRIPT, text.replace('[[line: L1]]', 'A new opening beat.\n\n[[line: L1]]'));

    const after = await lineIds('arrival');
    expect(after.slice(1)).toEqual(before);
    expect(before).not.toContain(after[0]);
  });

  it('refuses a scene it does not have, and writes nothing', async () => {
    const before = await p.read(SCRIPT);
    const preview = await session.previewLineIds('nope');
    expect(preview.ok).toBe(false);
    expect(await session.writeLineIds('nope')).toMatchObject({ ok: false, written: [] });
    expect(await p.read(SCRIPT)).toBe(before);
  });
});

/**
 * The same write paths against `scenes/<id>.md`. A rewire that spans two scenes spans two files
 * here, which is the whole difference — so these assert on *which* files were written, and on
 * the front-matter surviving a patch that only ever meant to touch prose.
 */
describe('WorkspaceSession — scenes authored as chunks', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ title: 'Chunks', script: SCRIPTS.diamond, format: 'chunks' });
    session = sessionFor(p);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  /**
   * Drop the `[[line:]]`/`[[nextline:]]` marks `sceneToFountain` wrote, leaving bodies that read
   * like hand-authored ones — a fixture chunk is born fully marked, so nothing else would.
   */
  const unmark = async (): Promise<void> => {
    for (const id of ['arrival', 'greet', 'observe', 'rooftop']) {
      const file = `scenes/${id}.md`;
      await p.write(
        file,
        (await p.read(file)).replace(/^\[\[(?:line|nextline):[^\]]*\]\]\n/gm, ''),
      );
    }
  };

  it('reads the same graph out of one file per scene', async () => {
    const graph = await session.storyGraph();
    expect(graph.start).toBe('arrival');
    expect(graph.scenes.map((s) => s.id)).toEqual(['arrival', 'greet', 'observe', 'rooftop']);
    expect(graph.edges.map((e) => e.id)).toEqual([
      'arrival#choice:0',
      'arrival#choice:1',
      'greet#next',
      'observe#next',
    ]);
    expect(graph.scenes.every((s) => s.reachable)).toBe(true);
  });

  it('names the chunk each scene lives in, and reports no screenplay', async () => {
    const index = await session.index();
    expect(index.screenplay).toBeUndefined();
    expect(index.scenes.map((s) => s.file?.endsWith(`scenes${sep}${s.id}.md`))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('patches only the chunks a rewire touches, front-matter untouched', async () => {
    // A comment is the sharp case: re-serializing the YAML would drop it, splicing keeps it.
    const arrival = await p.read('scenes/arrival.md');
    await p.write('scenes/arrival.md', arrival.replace('---\n', '---\n# hand-written\n'));
    const greet = await p.read('scenes/greet.md');

    const result = await session.editBranches((scenes) =>
      spliceScene(scenes, { scene: 'rooftop', from: 'arrival', edge: 0 }),
    );

    expect(result.ok).toBe(true);
    expect(result.written).toEqual(['scenes/arrival.md', 'scenes/rooftop.md']);
    expect(await p.read('scenes/greet.md')).toBe(greet);

    const patched = await p.read('scenes/arrival.md');
    expect(patched).toContain('# hand-written');
    expect(patched).toContain('scene: arrival');
    // The id stays the front-matter's: a body that named itself could contradict its own file.
    expect(patched).not.toContain('[[scene:');
    expect(await p.read('scenes/rooftop.md')).toContain('[[next: greet]]');

    const edges = result.graph?.edges ?? [];
    expect(edges.find((e) => e.id === 'arrival#choice:0')).toMatchObject({
      to: 'rooftop',
      label: 'Speak up',
    });
    expect(edges.find((e) => e.id === 'rooftop#next')).toMatchObject({ to: 'greet' });
  });

  it('refuses a rewire without writing any chunk', async () => {
    const before = await p.read('scenes/arrival.md');
    const result = await session.editBranches((scenes) =>
      spliceScene(scenes, { scene: 'arrival', from: 'greet' }),
    );
    expect(result).toMatchObject({ ok: false, written: [] });
    expect(await p.read('scenes/arrival.md')).toBe(before);
  });

  it('finds a written chunk already marked — the writer emits the ids it read', async () => {
    const result = await session.writeLineIds();
    expect(result).toMatchObject({ ok: true, written: [] });
    expect(result.message).toContain('already carries its id');
  });

  it('writes line ids into every chunk that lacks them', async () => {
    await unmark();
    const result = await session.writeLineIds();
    expect(result).toMatchObject({ ok: true });
    expect(result.written).toEqual([
      'scenes/arrival.md',
      'scenes/greet.md',
      'scenes/observe.md',
      'scenes/rooftop.md',
    ]);
    expect(await p.read('scenes/greet.md')).toContain('[[line: L1]]');

    const again = await session.writeLineIds();
    expect(again).toMatchObject({ ok: true, written: [] });
    expect(again.message).toContain('already carries its id');
  });

  it('scopes a line-id write to the one chunk holding that scene', async () => {
    await unmark();
    const result = await session.writeLineIds('greet');
    expect(result).toMatchObject({ ok: true, written: ['scenes/greet.md'] });
    expect(result.message).toContain('scene "greet"');
    expect(await p.read('scenes/arrival.md')).not.toContain('[[line:');
  });
});

/**
 * `workspace.import` and `story.screenplay`: the migration into the chunk form, and the way back
 * out of it. The import is asserted by what the *model* says afterwards — a conversion that lost
 * or renamed a scene would detach its shots, so "same graph" is the contract, not "same bytes".
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
    const before = await session.storyGraph();

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
    // The screenplay stops being a `.fountain` — otherwise the project now holds both forms.
    expect(await has('screenplay/script.fountain')).toBe(false);
    expect(await has('screenplay/script.fountain.imported')).toBe(true);
    // A directory has no document order, so the entry has to be written down.
    expect(await p.read('project.yaml')).toContain('start: arrival');

    const after = await session.storyGraph();
    expect(after.scenes).toEqual(before.scenes);
    expect(after.edges).toEqual(before.edges);
    expect(after.diagnostics).toEqual([]);
  });

  it('refuses to import over chunks that already exist, and over nothing to import', async () => {
    p = await makeProject({ title: 'No import', script: SCRIPTS.linear, format: 'chunks' });
    session = sessionFor(p);

    const preview = await session.previewImport();
    expect(preview.ok).toBe(false);
    expect(preview.message).toContain('already holds 2 chunk(s)');
    expect(await session.importScreenplay()).toMatchObject({ ok: false, written: [] });

    // Same refusal from the other side: chunks removed, there is no screenplay either.
    await fs.rm(join(p.dir, 'scenes'), { recursive: true });
    expect(await session.previewImport()).toMatchObject({
      ok: false,
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

    // Clean output is a reading copy: the ids and the branches go with the markers.
    const clean = await session.writeScreenplay(true);
    expect(clean.message).toContain('cannot be imported back');
    expect(await p.read('screenplay.fountain')).not.toContain('[[');
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
