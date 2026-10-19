import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { exists } from '@vn/util';
import { run, tempProject, tool } from './testkit.js';

/**
 * The agent's collector deletes at once, in either host, and reports every path it removed. The
 * rule that decides what goes is `@vn/gengraph`'s, which has its own suite over a rendered project;
 * these cases cover the seam.
 */
describe('collect_unused_assets', () => {
  const STRAY = `vngen/build/assets/${'ab'.repeat(32)}.png`;
  const plant = async (dir: string): Promise<void> => {
    await fs.mkdir(join(dir, 'vngen', 'build', 'assets'), { recursive: true });
    await fs.writeFile(join(dir, STRAY), 'left behind');
  };

  it('is mutating and always confirmed', () => {
    expect(tool('collect_unused_assets')).toMatchObject({ mutating: true, confirm: true });
  });

  it('asks with the counts, saying the app cannot undo it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await plant(dir);
      const asked = await tool('collect_unused_assets').confirmText!({}, ctx);
      expect(asked?.split('\n')).toEqual([
        expect.stringMatching(/^Removes 1 picture \(11 B\) that nothing in the project uses\.$/),
        '1 picture is in no commit, so git cannot bring it back.',
        'They are files no manifest lists (1).',
        'The files are deleted now, and the app cannot undo it.',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('deletes what nothing uses, reports it, and leaves the app’s held collections alone', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await plant(dir);
      const held = join(dir, 'vngen', 'state', 'collected', 'abc123', 'plan.json');
      await fs.mkdir(join(held, '..'), { recursive: true });
      await fs.writeFile(held, '{}');

      const r = await run('collect_unused_assets', {}, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toMatch(/^Removed 1 picture/);
      expect(r.written).toEqual([STRAY]);
      expect(await exists(join(dir, STRAY))).toBe(false);
      expect(await exists(held)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('says so when there is nothing to collect', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('collect_unused_assets', {}, ctx);
      expect(r).toMatchObject({ ok: true, output: expect.stringMatching(/^Nothing to collect/) });
    } finally {
      await cleanup();
    }
  });

  it('refuses while the host is running the pipeline', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await plant(dir);
      const r = await run('collect_unused_assets', {}, { ...ctx, busy: () => 'a pipeline run' });
      expect(r).toMatchObject({
        ok    : false,
        output: 'Nothing was collected: a pipeline run is in progress.',
      });
      expect(await exists(join(dir, STRAY))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
