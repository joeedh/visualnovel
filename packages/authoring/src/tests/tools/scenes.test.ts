import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ProjectPaths, readShots, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
import { CHUNKS, run, tempProject, tool } from './testkit.js';

/**
 * `edit_scene` is the agent's only prose write path, and it is the same write path the desktop's
 * `story.*` commands use — the decisions, the refusals and the storyboard accounting all come from
 * `@vn/scriptedit`, which has its own suites for each. These cases cover the seam: which file
 * changed, what the tool refuses on its own, and what it reports.
 */
describe('edit_scene', () => {
  it('retypes a line, writing only that chunk', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        { op: 'setLineText', line: 'arrival:L1', text: 'Good afternoon.' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/arrival.md']);
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text).toContain('Good afternoon.');
      // The first edit canonicalizes the chunk, line-id marks included — there is no surgical
      // form of a prose edit, so the ids the reader allocated get written down.
      expect(text).toContain('[[line: L1]]');
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });

  it('drafts a run of prose in one call, in the order it was given', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        {
          op   : 'insertLines',
          scene: 'arrival',
          after: 'arrival:L1',
          lines: [
            { speaker: 'REN', text: 'You are in my seat.' },
            { kind: 'narration', text: 'Aiko does not look up.' },
            { speaker: 'AIKO', text: 'I know.' },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/arrival.md']);
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text.indexOf('You are in my seat.')).toBeLessThan(
        text.indexOf('Aiko does not look up.'),
      );
      expect(text.indexOf('Aiko does not look up.')).toBeLessThan(text.indexOf('I know.'));
    } finally {
      await cleanup();
    }
  });

  it('writes none of a run when one line of it is refused', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        {
          op   : 'insertLines',
          scene: 'arrival',
          after: '',
          lines: [{ kind: 'narration', text: 'Fine.' }, { text: 'Who says this?' }],
        },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('line 2 of 2');
      expect(r.output).toContain('Nothing was inserted.');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('creates a scene chunk from a heading', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        { op: 'newScene', scene: 'rooftop', heading: 'EXT. ROOFTOP - DUSK' },
        ctx,
      );
      expect(r.ok).toBe(true);
      const text = await fs.readFile(join(dir, 'scenes', 'rooftop.md'), 'utf8');
      expect(text).toContain('scene: rooftop');
      expect(text).toContain('EXT. ROOFTOP - DUSK');
    } finally {
      await cleanup();
    }
  });

  it('creates a scene with a synopsis, and sets or clears one later', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const made = await run(
        'edit_scene',
        {
          op      : 'newScene',
          scene   : 'rooftop',
          heading : 'EXT. ROOFTOP - DUSK',
          synopsis: 'Ren waits on the roof while the city lights come on.',
        },
        ctx,
      );
      expect(made.ok).toBe(true);
      expect(made.output).toContain('with a synopsis');
      const file = join(dir, 'scenes', 'rooftop.md');
      expect(await fs.readFile(file, 'utf8')).toContain(
        '= Ren waits on the roof while the city lights come on.',
      );
      // The synopsis round-trips through the parser the tool reads scenes back with.
      const shown = await run('parse_fountain', {}, ctx);
      expect(shown.data).toContainEqual(
        expect.objectContaining({
          id      : 'rooftop',
          synopsis: 'Ren waits on the roof while the city lights come on.',
        }),
      );

      const set = await run(
        'edit_scene',
        { op: 'setSynopsis', scene: 'rooftop', text: 'Ren gives up waiting.' },
        ctx,
      );
      expect(set.ok).toBe(true);
      expect(await fs.readFile(file, 'utf8')).toContain('= Ren gives up waiting.');
      expect(await fs.readFile(file, 'utf8')).not.toContain('city lights');

      const multi = await run(
        'edit_scene',
        { op: 'setSynopsis', scene: 'rooftop', text: 'one\ntwo' },
        ctx,
      );
      expect(multi.ok).toBe(false);
      expect(multi.output).toBe('A synopsis is one line; put a longer beat in the prose.');

      const cleared = await run(
        'edit_scene',
        { op: 'setSynopsis', scene: 'rooftop', text: '' },
        ctx,
      );
      expect(cleared.ok).toBe(true);
      expect(await fs.readFile(file, 'utf8')).not.toContain('= ');
    } finally {
      await cleanup();
    }
  });

  it('names the arguments an op needs instead of guessing them', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_scene', { op: 'splitScene', scene: 'arrival' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toBe('splitScene needs: at, into');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('refuses an argument the op does not read rather than dropping it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      // The case that happened: a scaffold passed its summary as `lines`, and 24 scenes were
      // written empty with nothing said.
      const scaffold = await run(
        'edit_scene',
        {
          op     : 'newScene',
          scene  : 'rooftop',
          heading: 'EXT. ROOFTOP - DUSK',
          lines  : [{ kind: 'narration', text: 'Ren waits.' }],
        },
        ctx,
      );
      expect(scaffold.ok).toBe(false);
      expect(scaffold.output).toBe(
        'newScene does not take lines; create the scene, then edit_scene op=insertLines to ' +
          'write its body, or pass synopsis for a one-line summary.',
      );
      await expect(fs.access(join(dir, 'scenes', 'rooftop.md'))).rejects.toThrow();

      const surplus = await run(
        'edit_scene',
        { op: 'deleteLine', line: 'arrival:L1', after: 'arrival:L2' },
        ctx,
      );
      expect(surplus.ok).toBe(false);
      expect(surplus.output).toBe('deleteLine does not take after');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);

      // A key the schema has never heard of is refused before the tool runs.
      const unknown = tool('edit_scene').args.safeParse({
        op     : 'newScene',
        scene  : 'rooftop',
        heading: 'EXT. ROOFTOP - DUSK',
        summary: 'Ren waits.',
      });
      expect(unknown.success).toBe(false);
      expect(unknown.success || unknown.error.issues[0]?.message).toMatch(/summary/);

      // A redundant `scene` on a line op is harmless and accepted.
      const redundant = await run(
        'edit_scene',
        { op: 'setLineText', scene: 'arrival', line: 'arrival:L1', text: 'Good afternoon.' },
        ctx,
      );
      expect(redundant.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('passes a refusal through from the rules, untouched', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_scene', { op: 'deleteScene', scene: 'ending' }, ctx);
      expect(r.ok).toBe(false);
      // `lineops` writes this sentence, and it names every referrer, which is what makes it
      // actionable.
      expect(r.output).toContain('greet (next)');
      expect(r.output).toContain('observe (next)');
      expect(await fs.readFile(join(dir, 'scenes', 'ending.md'), 'utf8')).toBe(CHUNKS.ending);
    } finally {
      await cleanup();
    }
  });

  it('reports what an edit costs the storyboard, and rewrites it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      const shot: Shot = {
        id         : 'arrival__beat1',
        sceneId    : 'arrival',
        framing    : 'medium',
        location   : 'classroom',
        subjects   : [{ characterId: 'aiko', outfit: 'uniform' }],
        coversLines: ['arrival:L1'],
        status     : 'pending',
      };
      await writeShots(paths, 'arrival', [shot]);

      const r = await run('edit_scene', { op: 'deleteLine', line: 'arrival:L1' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('1 shot(s) lose 1 line(s) of coverage');
      expect(r.output).toContain('1 shot(s) end up covering nothing');
      // The shot stays in the storyboard even though it now covers nothing, because its art was
      // already generated and paid for, and only the author may delete it. The storyboard file
      // is rewritten to record that, and it appears in `written`.
      const after = await readShots(paths, 'arrival');
      expect(after?.shots.map((s) => s.coversLines)).toEqual([[]]);
      expect(r.written).toContain('vngen/work/shots/arrival.json');
    } finally {
      await cleanup();
    }
  });

  /**
   * Reordering is the one act whose rule needs the storyboard rather than only costing it
   * something. It moves prose, so it writes the chunk, and it moves whole shots, so the
   * storyboard is untouched.
   */
  it('reorders a shot by moving the lines it covers, and leaves the storyboard alone', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      const shot = (id: string, coversLines: string[]): Shot => ({
        id,
        sceneId : 'ending',
        framing : 'medium',
        location: 'classroom',
        subjects: [],
        coversLines,
        status: 'pending',
      });
      const shots = [
        shot('ending__a', ['ending:L1']),
        shot('ending__b', ['ending:L2', 'ending:L3']),
      ];
      await writeShots(paths, 'ending', shots);

      const r = await run(
        'edit_scene',
        { op: 'moveShot', scene: 'ending', shot: 'ending__b' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/ending.md']);
      expect(r.output).toContain('nothing drifts');

      const text = await fs.readFile(join(dir, 'scenes', 'ending.md'), 'utf8');
      expect(text.indexOf('Goodbye.')).toBeLessThan(text.indexOf('The end.'));
      // The shots file is not in `written` and says exactly what it said before: a reorder moves
      // whole shots, so no coverage changes and no line's own shot changes.
      expect((await readShots(paths, 'ending'))?.shots).toEqual(shots);
    } finally {
      await cleanup();
    }
  });

  it('refuses to reorder shots in a scene nothing has decomposed yet', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        { op: 'moveShot', scene: 'arrival', shot: 'arrival__beat1' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('no decomposition yet');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });
});

/**
 * `edit_branches` is the agent's only way to say what leads where. The rules are `@vn/scriptedit`'s
 * `branchops` and are tested there, so these cases cover the seam — and the bug the tool exists to
 * fix, which is that a scene the agent created had nothing that could point at it.
 */
describe('edit_branches', () => {
  it('links a scene the agent just created, which is the whole reason it exists', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const made = await run(
        'edit_scene',
        { op: 'newScene', scene: 'rooftop', heading: 'EXT. ROOFTOP - DUSK' },
        ctx,
      );
      expect(made.ok).toBe(true);
      // `newScene` reports that nothing points at the new scene, and before `edit_branches` there
      // was no way to act on that. The reported bug is reproduced here: a scene the agent made
      // that the story cannot get to.
      expect(made.output).toContain('nothing points at it yet');
      expect((await run('story_graph', {}, ctx)).output).toContain('Unreachable: rooftop');

      const wired = await run(
        'edit_branches',
        { op: 'setNext', scene: 'rooftop', goto: 'ending' },
        ctx,
      );
      expect(wired.ok).toBe(true);
      expect(wired.written).toEqual(['scenes/rooftop.md']);
      expect(await fs.readFile(join(dir, 'scenes', 'rooftop.md'), 'utf8')).toContain(
        '[[next: ending]]',
      );

      const inbound = await run(
        'edit_branches',
        { op: 'setChoice', scene: 'arrival', goto: 'rooftop', label: 'Go up' },
        ctx,
      );
      expect(inbound.ok).toBe(true);
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toContain(
        '[[choice: "Go up" -> rooftop]]',
      );

      // With the wiring in place the graph reaches rooftop, and nothing dangles.
      const graph = await run('story_graph', {}, ctx);
      expect(graph.output).toContain('Unreachable: none');
      expect(graph.output).toContain('Dangling: none');
    } finally {
      await cleanup();
    }
  });

  it('splices a scene into an existing edge as one two-scene patch', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      expect(
        (
          await run(
            'edit_scene',
            { op: 'newScene', scene: 'stairs', heading: 'INT. STAIRS - DAY' },
            ctx,
          )
        ).ok,
      ).toBe(true);
      const r = await run(
        'edit_branches',
        { op: 'spliceScene', scene: 'stairs', from: 'greet' },
        ctx,
      );

      expect(r.ok).toBe(true);
      expect(r.output).toContain('Spliced stairs into greet → ending');
      expect((r.written ?? []).sort()).toEqual(['scenes/greet.md', 'scenes/stairs.md']);
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toContain(
        '[[next: stairs]]',
      );
      expect(await fs.readFile(join(dir, 'scenes', 'stairs.md'), 'utf8')).toContain(
        '[[next: ending]]',
      );
    } finally {
      await cleanup();
    }
  });

  it('names the arguments an op needs, and refuses one the op does not read', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_branches', { op: 'setChoice', scene: 'arrival' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toBe('setChoice needs: goto, label');
      const surplus = await run(
        'edit_branches',
        { op: 'setNext', scene: 'arrival', goto: 'ending', label: 'Go' },
        ctx,
      );
      expect(surplus.ok).toBe(false);
      expect(surplus.output).toBe('setNext does not take label');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('passes a refusal through from the rules, untouched, and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      // `arrival` forks, and `next` is only followed by a scene with no choices — so the spliced
      // edge would never be taken. `branchops` refuses in exactly those words.
      const r = await run(
        'edit_branches',
        { op: 'spliceScene', scene: 'arrival', from: 'greet' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('would never be taken');
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });

  it('writes nothing when the wiring already says what it was asked to say', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_branches', { op: 'setNext', scene: 'greet', goto: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('already wired that way');
      expect(r.written).toBeUndefined();
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });
});
