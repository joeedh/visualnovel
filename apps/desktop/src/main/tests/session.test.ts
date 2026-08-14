/**
 * `WorkspaceSession` is the main-process join point every `story.*` / `gate.*` / `pipeline.*`
 * command routes through. It is Electron-free by construction, so it can be driven directly
 * over a real generated project — testkit runs the pipeline, the session reads it back.
 */
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import {
  deleteScene,
  insertLine,
  mergeScene,
  newScene,
  setLineText,
  splitScene,
} from '@vn/scriptedit';
import { readShots, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
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

  // What `workspace.open` refuses on: a session with work in flight is one nobody may replace.
  it('names the work in flight from the call, not from when the scheduler starts', async () => {
    const session = sessionFor(p);
    expect(session.busy()).toBeUndefined();

    const running = session.runPipeline(true);
    expect(session.busy()).toBe('a pipeline run');
    await running;
    expect(session.busy()).toBeUndefined();
  });

  it('builds a playable with no asset refs while nothing is generated', async () => {
    const play = await sessionFor(p).playable();
    expect(play.start).toBe('arrival');
    expect(play.characters['aiko']!.portrait).toBeUndefined();
    // The session reads it off `project.yaml`; a build that forgets to is how the runner ends
    // up staging portraits nobody asked for.
    expect(play.portraitOverlay).toBe(false);
  });
});

/**
 * The Wave 3 write path: `storyGraph` reads the wiring, `editBranches` rewires it. What is
 * asserted here is the *decision* — edges, reachability, refusals; which files a patch lands in
 * is the chunk-specific describe further down.
 */
describe('WorkspaceSession — branch editing', () => {
  const ROOFTOP = 'scenes/rooftop.md';
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
    const before = await p.read(ROOFTOP);
    const result = await session.editBranches((scenes) =>
      setNext(scenes, { scene: 'rooftop', goto: 'arrival' }),
    );

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([ROOFTOP]);
    const after = await p.read(ROOFTOP);
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

  it('refuses a rewire, saying which rule stopped it', async () => {
    const result = await session.editBranches((scenes) =>
      spliceScene(scenes, { scene: 'arrival', from: 'greet' }),
    );
    expect(result).toMatchObject({ ok: false, written: [] });
    expect(result.message).toContain('already forks');
  });

  it('reports a rewire that was already in place as writing nothing', async () => {
    const result = await session.editBranches((scenes) =>
      setNext(scenes, { scene: 'greet', goto: 'rooftop' }),
    );
    expect(result.ok).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.message).toContain('nothing written');
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
 * A fixture chunk is born fully marked — `sceneToFountain` writes what it read — so every test
 * here strips the marks first to get the hand-authored starting point the command exists for.
 */
describe('WorkspaceSession — line ids', () => {
  const ARRIVAL = 'scenes/arrival.md';
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ title: 'Line ids', script: SCRIPTS.linear });
    session = sessionFor(p);
    for (const id of ['arrival', 'rooftop']) {
      const file = `scenes/${id}.md`;
      await p.write(
        file,
        (await p.read(file)).replace(/^\[\[(?:line|nextline):[^\]]*\]\]\n/gm, ''),
      );
    }
  });

  afterEach(async () => {
    await p.cleanup();
  });

  const lineIds = async (scene: string) =>
    (await session.sceneCoverage(scene)).lines.map((l) => l.id);

  it('previews the marks without writing any', async () => {
    const before = await p.read(ARRIVAL);
    const preview = await session.previewLineIds();
    expect(preview.ok).toBe(true);
    expect(preview.assigned).toBeGreaterThan(0);
    expect(await p.read(ARRIVAL)).toBe(before);
  });

  it('writes the ids reading already allocated, changing none of them', async () => {
    const before = await lineIds('arrival');
    const result = await session.writeLineIds();
    expect(result.ok).toBe(true);
    expect(result.written).toContain(ARRIVAL);
    expect(await lineIds('arrival')).toEqual(before);
    expect(await p.read(ARRIVAL)).toContain('[[line: L1]]');
  });

  it('is a no-op the second time, and says so', async () => {
    await session.writeLineIds();
    const text = await p.read(ARRIVAL);
    const again = await session.writeLineIds();
    expect(again).toMatchObject({ ok: true, written: [] });
    expect(again.message).toContain('already carries its id');
    expect(await p.read(ARRIVAL)).toBe(text);
  });

  it('scopes to one scene, and holds ids still when a line is inserted above them', async () => {
    // The whole point of the plan: with marks written, an insertion allocates a fresh id
    // instead of shifting every id below it onto different prose.
    await session.writeLineIds('arrival');
    const before = await lineIds('arrival');

    const text = await p.read(ARRIVAL);
    await p.write(ARRIVAL, text.replace('[[line: L1]]', 'A new opening beat.\n\n[[line: L1]]'));

    const after = await lineIds('arrival');
    expect(after.slice(1)).toEqual(before);
    expect(before).not.toContain(after[0]);
  });

  it('refuses a scene it does not have, and writes nothing', async () => {
    const before = await p.read(ARRIVAL);
    const preview = await session.previewLineIds('nope');
    expect(preview.ok).toBe(false);
    expect(await session.writeLineIds('nope')).toMatchObject({ ok: false, written: [] });
    expect(await p.read(ARRIVAL)).toBe(before);
  });
});

/**
 * The same write paths, seen from the files. One scene is one `scenes/<id>.md`, so a rewire that
 * spans two scenes spans two files — these assert on *which* files were written, and on the
 * front-matter surviving a patch that only ever meant to touch prose.
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
    expect(result.graph?.scenes.every((s) => s.reachable)).toBe(true);
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
 * `editScene`: the one write path for prose. Every case here is about the *file* — which chunk the
 * edit landed in, what it still says, and what stopped existing — because the decision itself is
 * already pinned by `@vn/scriptedit`'s `lineops.test.ts`.
 */
describe('WorkspaceSession — prose editing', () => {
  const ROOFTOP = 'scenes/rooftop.md';
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ title: 'Prose', script: SCRIPTS.branching });
    session = sessionFor(p);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  const state = () => session.scriptState();

  it('retypes one line, in one chunk, keeping the cue the author typed', async () => {
    const arrival = await p.read('scenes/arrival.md');
    const result = await session.editScene((s) =>
      setLineText(s, { line: 'rooftop:L2', text: 'I got held up.' }),
    );

    expect(result).toMatchObject({ ok: true, written: [ROOFTOP], removed: [] });
    const text = await p.read(ROOFTOP);
    expect(text).toContain('I got held up.');
    expect(text).not.toContain('Sorry.');
    expect(await p.read('scenes/arrival.md')).toBe(arrival);
    // The state is parsed from the chunk, not from the model, so `AIKO` is still a cue and not
    // the `aiko` id `buildModel` resolves it to — which would come back out as `@aiko`.
    expect(text).toContain('\nAIKO\n');
    expect(text).not.toContain('@aiko');
  });

  it('keeps hand-written front-matter, and marks the ids it re-serialized', async () => {
    const before = await p.read(ROOFTOP);
    await p.write(
      ROOFTOP,
      before
        .replace('---\n', '---\n# hand-written\n')
        .replace(/^\[\[(?:line|nextline):.*\]\]\n/gm, ''),
    );

    await session.editScene((s) => setLineText(s, { line: 'rooftop:L1', text: 'The city hums.' }));

    const text = await p.read(ROOFTOP);
    expect(text).toContain('# hand-written');
    expect(text).toContain('scene: rooftop');
    // Re-serializing writes the marks: the first prose edit canonicalizes a hand-authored chunk.
    expect(text).toContain('[[line: L1]]');
    expect(text).toContain('[[nextline: 4]]');
  });

  it('allocates a fresh id for an inserted line, holding the others still', async () => {
    const before = (await session.sceneCoverage('rooftop')).lines.map((l) => l.id);
    const result = await session.editScene((s) =>
      insertLine(s, {
        scene: 'rooftop',
        after: 'rooftop:L1',
        kind: 'dialogue',
        speaker: 'HARUKI',
        text: 'You came.',
      }),
    );

    expect(result).toMatchObject({ ok: true, written: [ROOFTOP] });
    const after = (await session.sceneCoverage('rooftop')).lines;
    expect(after.map((l) => l.id)).toEqual([
      'rooftop:L1',
      'rooftop:L4',
      'rooftop:L2',
      'rooftop:L3',
    ]);
    expect(before).not.toContain('rooftop:L4');
    // Speakers on the way back out are resolved ids — the model's view, not the file's.
    expect(after[1]).toMatchObject({ speaker: 'haruki', text: 'You came.' });
  });

  it('reports an edit that changes nothing as writing nothing', async () => {
    const before = await p.read(ROOFTOP);
    const result = await session.editScene((s) =>
      setLineText(s, { line: 'rooftop:L2', text: 'Sorry.' }),
    );

    expect(result).toMatchObject({ ok: true, written: [], removed: [] });
    expect(result.message).toContain('nothing written');
    expect(await p.read(ROOFTOP)).toBe(before);
  });

  it('refuses to reorder shots in a scene nothing has decomposed yet', async () => {
    const before = await p.read(ROOFTOP);
    const result = await session.editScene(
      await session.shotOrder('rooftop', 'rooftop__beat1', ''),
    );

    expect(result).toMatchObject({ ok: false, written: [], removed: [] });
    expect(result.message).toContain('no decomposition yet');
    expect(await p.read(ROOFTOP)).toBe(before);
  });

  it('refuses an edit without touching a file', async () => {
    const before = await p.read(ROOFTOP);
    const result = await session.editScene((s) => deleteScene(s, { scene: 'rooftop' }));

    expect(result).toMatchObject({ ok: false, written: [], removed: [] });
    expect(result.message).toContain('arrival (next)');
    expect(await p.read(ROOFTOP)).toBe(before);
  });

  it('splits a scene into a new chunk, and the branch out goes with the tail', async () => {
    const result = await session.editScene((s) =>
      splitScene(s, { scene: 'rooftop', at: 'rooftop:L3', into: 'reply' }),
    );

    expect(result).toMatchObject({ ok: true, written: [ROOFTOP, 'scenes/reply.md'], removed: [] });
    const tail = await p.read('scenes/reply.md');
    expect(tail).toContain('scene: reply');
    expect(tail).toContain("Most people don't come up here.");
    // Local ids survive the move, which is what lets a shot follow its lines across the split.
    expect(tail).toContain('[[line: L3]]');
    expect(await p.read(ROOFTOP)).not.toContain('[[choice:');

    const edges = result.graph?.edges ?? [];
    expect(edges.find((e) => e.id === 'rooftop#next')).toMatchObject({ to: 'reply' });
    expect(edges.find((e) => e.id === 'reply#choice:0')).toMatchObject({ to: 'good_end' });
    expect(result.graph?.scenes.every((sc) => sc.reachable)).toBe(true);
  });

  it('merges a linear continuation, renumbering the lines it absorbs', async () => {
    const result = await session.editScene((s) =>
      mergeScene(s, { scene: 'rooftop', into: 'arrival' }),
    );

    expect(result).toMatchObject({
      ok: true,
      written: ['scenes/arrival.md'],
      removed: [ROOFTOP],
    });
    expect(result.message).toContain('3 line(s) appended');

    const merged = await session.sceneCoverage('arrival');
    expect(merged.lines.map((l) => l.id)).toEqual([
      'arrival:L1',
      'arrival:L2',
      'arrival:L3',
      'arrival:L4',
      'arrival:L5',
    ]);
    expect(result.graph?.scenes.map((sc) => sc.id)).toEqual(['arrival', 'bad_end', 'good_end']);
    expect(result.graph?.edges.find((e) => e.id === 'arrival#choice:0')).toMatchObject({
      to: 'good_end',
    });
  });

  it('creates an empty chunk nothing points at, and can delete it again', async () => {
    const created = await session.editScene((s) =>
      newScene(s, { scene: 'attic', heading: 'INT. ATTIC - NIGHT' }),
    );
    expect(created).toMatchObject({ ok: true, written: ['scenes/attic.md'] });
    expect(await p.read('scenes/attic.md')).toContain('INT. ATTIC - NIGHT');
    expect(created.graph?.scenes.find((sc) => sc.id === 'attic')).toMatchObject({
      reachable: false,
    });

    const removed = await session.editScene((s) => deleteScene(s, { scene: 'attic' }));
    expect(removed).toMatchObject({ ok: true, written: [], removed: ['scenes/attic.md'] });
    expect(removed.graph?.scenes.map((sc) => sc.id)).not.toContain('attic');
  });

  /** A hand-laid storyboard, written through the writer the planner uses. */
  const storyboard = async (sceneId: string, coverage: Record<string, string[]>): Promise<void> => {
    const shots: Shot[] = Object.entries(coverage).map(([id, coversLines]) => ({
      id: `${sceneId}__${id}`,
      sceneId,
      framing: 'medium',
      location: 'rooftop/sunset',
      subjects: [],
      coversLines,
      image: `image-of-${id}`,
      status: 'accepted',
    }));
    await writeShots(p.paths, sceneId, shots);
  };

  const shotsOf = async (sceneId: string): Promise<Record<string, string[]> | null> => {
    const loaded = await readShots(p.paths, sceneId);
    if (!loaded) return null;
    return Object.fromEntries(loaded.shots.map((s) => [s.id, s.coversLines]));
  };

  it('carries a shot into the file of the scene its lines left for', async () => {
    await storyboard('rooftop', { establishing: ['rooftop:L1'], beat1: ['rooftop:L3'] });
    const result = await session.editScene((s) =>
      splitScene(s, { scene: 'rooftop', at: 'rooftop:L3', into: 'reply' }),
    );

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([
      ROOFTOP,
      'scenes/reply.md',
      'vngen/work/shots/rooftop.json',
      'vngen/work/shots/reply.json',
    ]);
    // Its id is part of its task hash, so it keeps the one it was minted with; only the file and
    // the covered ids move, which is what keeps the generated image the answer to its own task.
    expect(await shotsOf('reply')).toEqual({ rooftop__beat1: ['reply:L3'] });
    expect(await shotsOf('rooftop')).toEqual({ rooftop__establishing: ['rooftop:L1'] });
    expect(result.message).toContain('1 shot(s) follow their lines into reply');
  });

  it('deletes the storyboard of a scene that stopped existing', async () => {
    await storyboard('rooftop', { establishing: ['rooftop:L1', 'rooftop:L2', 'rooftop:L3'] });
    const result = await session.editScene((s) =>
      mergeScene(s, { scene: 'rooftop', into: 'arrival' }),
    );

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([ROOFTOP, 'vngen/work/shots/rooftop.json']);
    // The merge renumbered every absorbed line, and the shot followed the mapping.
    expect(await shotsOf('arrival')).toEqual({
      rooftop__establishing: ['arrival:L3', 'arrival:L4', 'arrival:L5'],
    });
    expect(await shotsOf('rooftop')).toBeNull();
  });

  it('warns that a retyped line leaves its rendered shot behind', async () => {
    await storyboard('rooftop', { establishing: ['rooftop:L2'] });
    const preview = await session.previewSceneEdit((s) =>
      setLineText(s, { line: 'rooftop:L2', text: 'I got held up.' }),
    );

    expect(preview.ok).toBe(true);
    expect(preview.message).toContain('will not re-render on their own');
    // Saying it is all it does: the storyboard is untouched, because nothing about it changed.
    const result = await session.editScene((s) =>
      setLineText(s, { line: 'rooftop:L2', text: 'I got held up.' }),
    );
    expect(result.written).toEqual([ROOFTOP]);
    expect(await shotsOf('rooftop')).toEqual({ rooftop__establishing: ['rooftop:L2'] });
  });

  it('refuses a preview with the sentence the run would refuse with', async () => {
    const preview = await session.previewSceneEdit((s) => deleteScene(s, { scene: 'rooftop' }));
    expect(preview).toMatchObject({ ok: false });
    expect(preview.message).toContain('arrival (next)');
  });

  it('hands the checks the scenes as their files parse', async () => {
    const s = await state();
    expect([...s.scenes.keys()]).toEqual(['arrival', 'bad_end', 'good_end', 'rooftop']);
    expect(s.entry).toBe('arrival');
    expect(s.scenes.get('rooftop')?.lines[1]).toMatchObject({ speaker: 'AIKO', text: 'Sorry.' });
  });
});

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
      title: 'Outfits',
      script: SCRIPTS.linear,
      characters: [{ id: 'aiko', outfits: { uniform: 'navy blazer', track: 'club tracksuit' } }],
    });
    session = sessionFor(p);
    await writeShots(p.paths, 'arrival', [
      {
        id: 'arrival__beat1',
        sceneId: 'arrival',
        framing: 'medium',
        location: 'classroom/day',
        subjects: [{ characterId: 'aiko' }],
        coversLines: ['arrival:L2'],
        status: 'pending',
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

    // A noop rather than a plain refusal: the control offering it is dropped, not disabled.
    expect(await session.previewSceneOutfit('arrival', 'aiko', 'track')).toMatchObject({
      ok: false,
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
   * The timeline's outfit strip is built entirely from `story:coverage`, so what it can offer and
   * what it says is in force are both this payload. A subject that inherits carries nothing — the
   * strip resolves it, and a map that pre-filled the answer would erase the distinction.
   */
  it('carries the wardrobe and the overrides in the coverage the strip is built from', async () => {
    const before = await session.sceneCoverage('arrival');
    expect(before.cast).toContainEqual({
      id: 'aiko',
      outfits: ['uniform', 'track'],
      defaultOutfit: 'uniform',
    });
    expect(before.shots[0]!.outfits).toEqual({});

    await session.editBranches(await session.sceneOutfit('arrival', 'aiko', 'track'));
    await session.setShotOutfit('arrival', 'arrival__beat1', 'aiko', 'uniform');

    const after = await session.sceneCoverage('arrival');
    expect(after.cast.find((c) => c.id === 'aiko')?.marked).toBe('track');
    expect(after.shots[0]!.outfits).toEqual({ aiko: 'uniform' });
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
    // Unimported, the screenplay builds nothing: the graph is empty and says why.
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

    // The graph the import produced is the graph the same story authored as chunks gives.
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

describe('WorkspaceSession — the story bible', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({
      title: 'Bible',
      script: SCRIPTS.linear,
      files: {
        'wiki/history/canal.md': '# The canal\n\nThe school was raised over a filled canal.\n',
        'wiki/cast/notes.md': '# Notes\n\nAiko has never seen the canal drained.\n',
      },
    });
    session = sessionFor(p);
  });

  afterAll(async () => {
    await p.cleanup();
  });

  it('ranks passages by query, reporting the file each came from', async () => {
    const hits = await session.searchBible('canal');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.file)).toContain('history/canal.md');
    expect(hits[0]!.text).toContain('canal');
  });

  it('honours a limit and returns nothing for a query that matches nothing', async () => {
    expect(await session.searchBible('canal', 1)).toHaveLength(1);
    expect(await session.searchBible('submarine')).toEqual([]);
  });

  it('sees a file written after the session was built', async () => {
    await fs.writeFile(join(p.dir, 'wiki', 'later.md'), '# Later\n\nA submarine, improbably.\n');
    expect((await session.searchBible('submarine')).map((h) => h.file)).toEqual(['later.md']);
  });
});

/**
 * The whole-document read and write behind `doc.*`. The refusals are where the risk is: a save
 * that overwrites someone else's edit, a save that quietly deletes an entity, and prose written
 * by the one path that does not validate it.
 */
describe('WorkspaceSession — documents', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({
      title: 'Docs',
      script: SCRIPTS.linear,
      files: { 'wiki/history.md': '# History\n\nThe canal was filled in 1911.\n' },
    });
    session = sessionFor(p);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  /** The read, the edit, the save, and the hash the next save will carry. */
  async function roundTrip(path: string, text: string) {
    const read = await session.readDoc(path);
    if (!read.ok) throw new Error(read.reason);
    return session.saveDoc(path, text, read.file.hash);
  }

  it('reads a note and saves it back, reporting the new hash', async () => {
    const saved = await roundTrip('wiki/history.md', '# History\n\nRewritten.\n');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.path).toBe('wiki/history.md');
    expect(await fs.readFile(join(p.dir, 'wiki', 'history.md'), 'utf8')).toBe(
      '# History\n\nRewritten.\n',
    );
    const reread = await session.readDoc('wiki/history.md');
    expect(reread.ok && reread.file.hash).toBe(saved.hash);
  });

  it('refuses a save over a file that changed underneath, naming both hashes', async () => {
    const read = await session.readDoc('wiki/history.md');
    if (!read.ok) throw new Error(read.reason);
    await fs.writeFile(join(p.dir, 'wiki', 'history.md'), '# History\n\nSomebody else.\n');
    const saved = await session.saveDoc('wiki/history.md', 'mine\n', read.file.hash);
    expect(saved.ok).toBe(false);
    expect(saved.ok ? '' : saved.reason).toMatch(/changed underneath this edit/);
  });

  it('refuses scenes/, outside the workspace, and unparseable front-matter', async () => {
    const scene = await session.saveDoc('scenes/arrival.md', 'INT. ANYWHERE - DAY\n', '');
    expect(scene.ok ? '' : scene.reason).toBe('scenes/arrival.md is written by story.*, not whole');
    const outside = await session.saveDoc('../escape.md', 'x', '');
    expect(outside.ok ? '' : outside.reason).toMatch(/outside the workspace/);
    const broken = await roundTrip('wiki/history.md', '---\nid: [unclosed\n---\n\nbody\n');
    expect(broken.ok ? '' : broken.reason).toMatch(/front-matter will not parse/);
  });

  it('saves a half-typed character sheet, with the schema failure beside it', async () => {
    const sheet = 'characters/aiko/character.md';
    const saved = await roundTrip(sheet, '---\nid: aiko\nname:\n---\n\nStill thinking.\n');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.diagnostic).toBeTruthy();
    expect(await fs.readFile(join(p.dir, ...sheet.split('/')), 'utf8')).toContain('Still thinking');
  });

  it('refuses a save that drops a type: tag, because that deletes the entity', async () => {
    const path = 'wiki/cast/ada.md';
    await fs.mkdir(join(p.dir, 'wiki', 'cast'), { recursive: true });
    await fs.writeFile(
      join(p.dir, ...path.split('/')),
      '---\nid: ada\ntype: character\n---\n\nx\n',
    );
    const dropped = await roundTrip(path, '---\nid: ada\n---\n\nx\n');
    expect(dropped.ok ? '' : dropped.reason).toMatch(/drops it — that deletes the character/);
  });

  it('scaffolds each kind in its conventional home, deriving the id from the name', async () => {
    const character = await session.createDoc('character', 'Ada Lovelace');
    expect(character.ok && character).toMatchObject({
      id: 'ada_lovelace',
      path: 'characters/ada_lovelace/character.md',
    });
    expect((await session.createDoc('location', 'The Roof')).ok && true).toBe(true);
    expect((await session.createDoc('note', 'Canal History')).ok).toBe(true);
    expect(await fs.readFile(join(p.dir, 'wiki', 'canal_history.md'), 'utf8')).toBe(
      '# Canal History\n',
    );
    // The new sheet is a real character, not a file nothing reads.
    expect((await session.index()).characters.map((c) => c.id)).toContain('ada_lovelace');
  });

  it('refuses to scaffold over a document already there', async () => {
    expect((await session.createDoc('character', 'Aiko')).ok).toBe(false);
    const again = await session.createDoc('character', 'Aiko');
    expect(again.ok ? '' : again.reason).toBe('characters/aiko/character.md already exists');
  });

  it('says what a save would do without doing it', async () => {
    const read = await session.readDoc('wiki/history.md');
    if (!read.ok) throw new Error(read.reason);
    const preview = await session.previewDoc('wiki/history.md', 'shorter\n', read.file.hash);
    expect(preview.ok && preview.note).toMatch(/^Overwrites wiki\/history\.md \(8 bytes\)\.$/);
    expect((await session.readDoc('wiki/history.md')).ok && true).toBe(true);
    expect(await fs.readFile(join(p.dir, 'wiki', 'history.md'), 'utf8')).toContain('1911');
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

  /**
   * The whole claim of `story.moveShot` in one assertion: the order of `show` beats changes,
   * and both frames still resolve to the images the run already paid for.
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
});
