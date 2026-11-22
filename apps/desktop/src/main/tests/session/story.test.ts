import { sep } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import {
  deleteScene,
  insertLine,
  mergeScene,
  newScene,
  setLineText,
  splitScene,
  setChoice,
  setNext,
  spliceScene,
} from '@vn/scriptedit';
import { readShots, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
import { WorkspaceSession } from '../../session.js';
import { sessionFor } from './helpers.js';

/**
 * The Wave 3 write path: `storyGraph` reads the wiring, `editBranches` rewires it. These cases
 * assert the decision — edges, reachability, refusals. Which files a patch lands in is asserted
 * by the chunk-specific describe further down.
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
      from    : 'arrival',
      to      : 'greet',
      kind    : 'choice',
      label   : 'Speak up',
      index   : 0,
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
 * `story.assignLineIds` writes down the ids reading allocated, so an insertion cannot move them.
 * A fixture chunk arrives fully marked because `sceneToFountain` writes what it read, so every
 * test here strips the marks first to reach the hand-authored starting point the command is for.
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
    // With marks written, an insertion allocates a fresh id instead of shifting every id after
    // it onto different prose.
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
 * spans two scenes spans two files. These cases assert which files were written, and that the
 * front-matter survives a patch that only meant to touch prose.
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
   * Drops the `[[line:]]`/`[[nextline:]]` marks `sceneToFountain` wrote, leaving bodies that read
   * like hand-authored ones. A fixture chunk arrives fully marked, so no other case would.
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
    // Re-serializing the YAML would drop a hand-written comment; splicing keeps it
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
    // The id stays in the front-matter, because a body that named itself could contradict its
    // own file
    expect(patched).not.toContain('[[scene:');
    expect(await p.read('scenes/rooftop.md')).toContain('[[next: greet]]');

    const edges = result.graph?.edges ?? [];
    expect(edges.find((e) => e.id === 'arrival#choice:0')).toMatchObject({
      to   : 'rooftop',
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
 * `editScene` is the one write path for prose. Every case here is about the file: which chunk the
 * edit landed in, what it still says, and what stopped existing. The decision itself is already
 * pinned by `@vn/scriptedit`'s `lineops.test.ts`.
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
    // Re-serializing writes the marks, so the first prose edit canonicalizes a hand-authored chunk
    expect(text).toContain('[[line: L1]]');
    expect(text).toContain('[[nextline: 4]]');
  });

  it('allocates a fresh id for an inserted line, holding the others still', async () => {
    const before = (await session.sceneCoverage('rooftop')).lines.map((l) => l.id);
    const result = await session.editScene((s) =>
      insertLine(s, {
        scene  : 'rooftop',
        after  : 'rooftop:L1',
        kind   : 'dialogue',
        speaker: 'HARUKI',
        text   : 'You came.',
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
      ok     : true,
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
      framing : 'medium',
      location: 'rooftop/sunset',
      subjects: [],
      coversLines,
      image: `image-of-${id}`,
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
    // A shot's id is part of its task hash, so the shot keeps the id it was minted with. Only the
    // file and the covered ids move, which keeps the generated image the answer to its own task.
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
    // The edit writes only the scene, leaving the storyboard untouched because the line ids the
    // shot covers did not change
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
