import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ProjectPaths, readShots, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
import type { ToolContext } from '../../index.js';
import { CHUNKS, run, tempProject } from './testkit.js';

/**
 * `set_outfit` writes one of two files from one sentence. The rules it runs are `@vn/scriptedit`'s
 * and are tested there, so these cases cover the seam — which level a `shot` argument picks, which
 * file that level writes, and that a refusal arrives verbatim rather than reworded.
 */
describe('set_outfit', () => {
  /** Dresses Aiko through `edit_character`, the same path an author would take. */
  const dressAiko = (ctx: ToolContext) =>
    run(
      'edit_character',
      { id: 'aiko', outfits: { uniform: 'School uniform.', track: 'Tracksuit.' } },
      ctx,
    );

  it('marks a whole scene, splicing the marker into that chunk alone', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      expect((await dressAiko(ctx)).ok).toBe(true);
      const r = await run(
        'set_outfit',
        { scene: 'arrival', character: 'aiko', outfit: 'track' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/arrival.md']);
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text).toContain('[[outfit: aiko=track]]');
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });

  it('clears a marker and names the level that answers instead', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await dressAiko(ctx);
      await run('set_outfit', { scene: 'arrival', character: 'aiko', outfit: 'track' }, ctx);
      const r = await run('set_outfit', { scene: 'arrival', character: 'aiko', outfit: '' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('"uniform"');
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text).not.toContain('[[outfit:');
    } finally {
      await cleanup();
    }
  });

  it('overrides one shot, writing the storyboard and not the prose', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await dressAiko(ctx);
      const paths = new ProjectPaths(dir);
      const shot: Shot = {
        id         : 'arrival__beat1',
        sceneId    : 'arrival',
        framing    : 'medium',
        location   : 'classroom',
        subjects   : [{ characterId: 'aiko' }],
        coversLines: ['arrival:L1'],
        status     : 'pending',
      };
      await writeShots(paths, 'arrival', [shot]);

      const r = await run(
        'set_outfit',
        { scene: 'arrival', shot: 'arrival__beat1', character: 'aiko', outfit: 'track' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/arrival.json']);
      const after = await readShots(paths, 'arrival');
      expect(after?.shots[0]!.subjects).toEqual([{ characterId: 'aiko', outfit: 'track' }]);
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('passes the wardrobe refusal through, listing what the sheet does author', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'set_outfit',
        { scene: 'arrival', character: 'aiko', outfit: 'track' },
        ctx,
      );
      expect(r.ok).toBe(false);
      // Nothing authored a wardrobe yet, so the only outfit is the default the sheet names.
      expect(r.output).toBe('"aiko" has no outfit "track" — they have "uniform".');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });
});

describe('set_variant', () => {
  const boarded = (variant: string, paths: ProjectPaths): Promise<unknown> =>
    writeShots(paths, 'arrival', [
      {
        id         : 'arrival__beat1',
        sceneId    : 'arrival',
        framing    : 'medium',
        location   : variant,
        subjects   : [{ characterId: 'aiko' }],
        coversLines: ['arrival:L1'],
        status     : 'pending',
      },
    ]);

  it('moves one shot to another variant and says the frame is drawn again', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      await boarded('day', paths);
      const r = await run(
        'set_variant',
        { scene: 'arrival', shot: 'arrival__beat1', variant: 'afternoon' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/arrival.json']);
      expect(r.output).toContain('drawn again');
      const after = await readShots(paths, 'arrival');
      expect(after?.shots[0]!.location).toBe('afternoon');
    } finally {
      await cleanup();
    }
  });

  it('gives the rule’s refusal, naming the variants the location does have', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      await boarded('day', paths);
      const r = await run(
        'set_variant',
        { scene: 'arrival', shot: 'arrival__beat1', variant: 'midnight' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('"day", "afternoon"');
      expect((await readShots(paths, 'arrival'))?.shots[0]!.location).toBe('day');
    } finally {
      await cleanup();
    }
  });

  it('refuses a scene with no storyboard rather than making one', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run(
        'set_variant',
        { scene: 'arrival', shot: 'arrival__beat1', variant: 'afternoon' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('no decomposition yet');
    } finally {
      await cleanup();
    }
  });
});
