import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectPaths, readShots } from '@vn/store';
import { exists } from '@vn/util';
import type { TextLLM } from '@vn/types';
import { run, tempProject, tool } from './testkit.js';

/**
 * The storyboard tools sit at the seam between the agent and `@vn/scriptedit`'s shot rules plus
 * `@vn/artgen`'s realization gauntlet, both tested where they live. These cases cover which file
 * each act writes (and that refusals write nothing), that the `nextShot` mark round-trips so a
 * deleted id stays retired, and that a proposal is read back rather than persisted.
 */
describe('storyboard tools', () => {
  /** A text seam that answers with fixed JSON — or refuses to parse, like the mock echo does. */
  const fakeText = (answer: string): TextLLM => ({
    complete  : () => Promise.resolve(answer),
    structured: async (_prompt, parse) => parse(answer),
  });

  it('read_shots on an undecomposed scene names both doors and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('read_shots', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('propose_storyboard');
      expect(r.output).toContain('newShot');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('newShot creates the storyboard, and the mark keeps a deleted id retired', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const first = await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L1'], framing: 'close' },
        ctx,
      );
      expect(first.ok).toBe(true);
      expect(first.written).toEqual(['vngen/work/shots/ending.json']);
      expect(first.output).toContain('ends decomposition');

      const second = await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L2'] },
        ctx,
      );
      expect(second.ok).toBe(true);

      const paths = new ProjectPaths(dir);
      let board = await readShots(paths, 'ending');
      expect(board?.shots.map((s) => s.id)).toEqual(['ending__shot1', 'ending__shot2']);
      // The speaker of the claimed line is the default cast; L1 has none.
      expect(board?.shots[0]!.subjects).toEqual([]);
      expect(board?.shots[0]!.framing).toBe('close');
      expect(board?.shots[1]!.subjects).toEqual([{ characterId: 'aiko' }]);

      const del = await run(
        'edit_scene',
        { op: 'deleteShot', scene: 'ending', shot: 'ending__shot2' },
        ctx,
      );
      expect(del.ok).toBe(true);
      expect(del.output).toContain('become uncovered');

      // The freed lines come back as a new frame, and shot2 stays retired.
      const again = await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L2'] },
        ctx,
      );
      expect(again.ok).toBe(true);
      board = await readShots(paths, 'ending');
      expect(board?.shots.map((s) => s.id)).toEqual(['ending__shot1', 'ending__shot3']);
    } finally {
      await cleanup();
    }
  });

  it('deleting the last shot deletes the file, so the scene is decomposed again', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('edit_scene', { op: 'newShot', scene: 'ending', lineIds: ['ending:L1'] }, ctx);
      const r = await run(
        'edit_scene',
        { op: 'deleteShot', scene: 'ending', shot: 'ending__shot1' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain('decomposed again');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('set_coverage restates the whole set, and a released line is reported as a gap', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L1', 'ending:L2'] },
        ctx,
      );
      const r = await run(
        'set_coverage',
        { scene: 'ending', shot: 'ending__shot1', lines: ['ending:L2', 'ending:L3'] },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/ending.json']);
      expect(r.output).toContain('uncovered');
      const board = await readShots(new ProjectPaths(dir), 'ending');
      expect(board?.shots[0]!.coversLines).toEqual(['ending:L2', 'ending:L3']);
    } finally {
      await cleanup();
    }
  });

  it('propose_storyboard refuses without a text seam', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('no text model');
    } finally {
      await cleanup();
    }
  });

  it('propose_storyboard reads a proposal into the conversation and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      ctx.text = fakeText(
        JSON.stringify({
          shots: [
            {
              id         : 'opener',
              framing    : 'wide',
              location   : 'day',
              subjects   : [{ characterId: 'aiko' }],
              coversLines: ['ending:L1', 'ending:L2', 'ending:L3'],
            },
          ],
        }),
      );
      const r = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('Proposed by the model.');
      expect(r.output).toContain('ending__opener');
      expect(r.output).toContain('Nothing is written.');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('propose_storyboard tells the decomposer what project.yaml says about style', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await writeFile(
        join(dir, 'project.yaml'),
        'title: Test Project\nstart: arrival\nart_style: ink wash\nstoryboard_notes: one splash per scene\n',
      );
      let system = '';
      ctx.text = {
        complete  : () => Promise.resolve(''),
        structured: async (_prompt, parse, sys) => {
          system = sys ?? '';
          return parse(
            JSON.stringify({
              shots: [
                {
                  id         : 'opener',
                  framing    : 'wide',
                  location   : 'day',
                  subjects   : [],
                  coversLines: ['ending:L1'],
                },
              ],
            }),
          );
        },
      };
      const r = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(system).toContain('The frames will be drawn in this art style: ink wash.');
      expect(system).toContain('Storyboard notes from the author: one splash per scene.');
    } finally {
      await cleanup();
    }
  });

  /**
   * The human listing prints framing, variant and cast but never `pose`, `expression` or
   * `camera`, so "restate these shots" was not literally possible from what the model could read.
   */
  it('propose_storyboard prints shots write_storyboard takes verbatim', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      ctx.text = fakeText(
        JSON.stringify({
          shots: [
            {
              id         : 'opener',
              framing    : 'wide',
              location   : 'day',
              camera     : 'slow push in',
              subjects   : [{ characterId: 'aiko', pose: 'seated', expression: 'wary' }],
              coversLines: ['ending:L1', 'ending:L2', 'ending:L3'],
            },
          ],
        }),
      );
      const proposal = await run('propose_storyboard', { scene: 'ending' }, ctx);
      const marker = 'it takes:\n';
      const shots = JSON.parse(
        proposal.output.slice(proposal.output.indexOf(marker) + marker.length),
      ) as unknown[];
      expect(shots).toEqual([
        {
          id         : 'ending__opener',
          framing    : 'wide',
          location   : 'day',
          camera     : 'slow push in',
          subjects   : [{ characterId: 'aiko', pose: 'seated', expression: 'wary' }],
          coversLines: ['ending:L1', 'ending:L2', 'ending:L3'],
        },
      ]);

      const w = await run('write_storyboard', { scene: 'ending', shots }, ctx);
      expect(w.ok).toBe(true);
      const board = await readShots(new ProjectPaths(dir), 'ending');
      expect(board?.shots[0]).toMatchObject({ camera: 'slow push in', location: 'day' });
    } finally {
      await cleanup();
    }
  });

  it('propose_storyboard reports the baseline with its reason when no model answer parses', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      ctx.text = fakeText('not json'); // the mock echo's behaviour: nothing a schema accepts
      const r = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('deterministic baseline');
    } finally {
      await cleanup();
    }
  });

  it('write_storyboard runs the batch gauntlet: namespaced ids, inventions dropped', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'write_storyboard',
        {
          scene: 'ending',
          shots: [
            {
              id         : 'opener',
              framing    : 'wide',
              location   : 'nowhere', // not a classroom variant — coerced to the first one
              subjects   : [{ characterId: 'AIKO' }, { characterId: 'ghost' }],
              coversLines: ['ending:L1', 'ending:L99'],
            },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/ending.json']);
      expect(r.output).toContain('ends decomposition');
      // The coercion is silent on disk, so the write has to say which frames it moved
      expect(r.output).toContain('ending__opener: "nowhere" → "day"');
      expect(r.output).toContain('set_variant');
      const board = await readShots(new ProjectPaths(dir), 'ending');
      const shot = board?.shots[0];
      expect(shot?.id).toBe('ending__opener');
      expect(shot?.location).toBe('day');
      expect(shot?.subjects).toEqual([{ characterId: 'aiko' }]); // case fixed, invention dropped
      expect(shot?.coversLines).toEqual(['ending:L1']);
    } finally {
      await cleanup();
    }
  });

  it('write_storyboard takes a page, places its panels by layout, and reads it back as one', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'write_storyboard',
        {
          scene: 'ending',
          shots: [
            {
              id         : 'page1',
              location   : 'day',
              subjects   : [{ characterId: 'aiko' }],
              aspect     : '3:4',
              layout     : 'diagonal-split',
              panels: [
                { framing: 'wide', subjects: [], coversLines: ['ending:L1'] },
                {
                  framing    : 'close',
                  subjects   : [{ characterId: 'aiko', expression: 'wry' }],
                  coversLines: ['ending:L2'],
                },
              ],
              coversLines: ['ending:L1', 'ending:L2'],
            },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain('[page · 2 @day]');
      expect(r.output).toContain('panel 2 (close): aiko — ending:L2');
      const board = await readShots(new ProjectPaths(dir), 'ending');
      const shot = board?.shots[0];
      expect(shot?.aspect).toBe('3:4');
      expect(shot?.framing).toBe('wide');
      expect(shot?.panels?.map((p) => p.shape.length)).toEqual([4, 4]);
      expect(shot?.panels?.[1]?.subjects).toEqual([{ characterId: 'aiko', expression: 'wry' }]);

      // What read_shots prints is the same picture, and a coverage take moves the panel line
      const c = await run(
        'set_coverage',
        { scene: 'ending', shot: 'ending__page1', lines: ['ending:L1', 'ending:L2', 'ending:L3'] },
        ctx,
      );
      expect(c.ok).toBe(true);
      expect(c.output).toContain('ending__page1 letters its lines, so it is drawn again');
      const after = await readShots(new ProjectPaths(dir), 'ending');
      expect(after?.shots[0]?.panels?.map((p) => p.coversLines)).toEqual([
        ['ending:L1'],
        ['ending:L2', 'ending:L3'],
      ]);
    } finally {
      await cleanup();
    }
  });

  it('write_storyboard rejects a shot key it does not take, rather than dropping it', () => {
    const shape = tool('write_storyboard').args;
    const shot = {
      id         : 'opener',
      framing    : 'wide',
      location   : 'day',
      subjects   : [],
      coversLines: ['ending:L1'],
    };
    expect(shape.safeParse({ scene: 'ending', shots: [shot] }).success).toBe(true);
    const stray = shape.safeParse({
      scene: 'ending',
      shots: [{ ...shot, variant: 'night' }],
    });
    expect(stray.success).toBe(false);
    if (stray.success) throw new Error('expected a rejection');
    expect(JSON.stringify(stray.error.issues)).toContain('variant');
  });

  it('write_storyboard refuses where a storyboard exists, and propose_storyboard does too', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('edit_scene', { op: 'newShot', scene: 'ending', lineIds: ['ending:L1'] }, ctx);
      const shots = [
        {
          id         : 'opener',
          framing    : 'wide',
          location   : 'day',
          subjects   : [],
          coversLines: ['ending:L1'],
        },
      ];
      const w = await run('write_storyboard', { scene: 'ending', shots }, ctx);
      expect(w.ok).toBe(false);
      expect(w.output).toContain('wins forever');

      ctx.text = fakeText('{"shots":[]}');
      const p = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(p.ok).toBe(false);
      expect(p.output).toContain('wins forever');

      const board = await readShots(new ProjectPaths(dir), 'ending');
      expect(board?.shots.map((s) => s.id)).toEqual(['ending__shot1']);
    } finally {
      await cleanup();
    }
  });

  it('write_storyboard refuses a list that binds nothing, rather than writing the baseline', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'write_storyboard',
        {
          scene: 'ending',
          shots: [
            {
              id         : 'opener',
              framing    : 'wide',
              location   : 'day',
              subjects   : [],
              coversLines: ['ending:L99'], // no real line — realization would baseline
            },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('refused:');
      expect(r.output).toContain('nothing was written');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
