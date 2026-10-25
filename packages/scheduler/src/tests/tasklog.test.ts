import { readTaskLog } from '@vn/pipeline';
import type { ImageBackend } from '@vn/providers';
import { SCRIPTS, makeProject } from '@vn/testkit';

const BLOCKING =
  '{"reviewer":"x","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';

function failingImages(message: string, cause?: Error): ImageBackend {
  const err = new Error(message, cause ? { cause } : undefined);
  return {
    modelId : 'broken',
    generate: () => Promise.reject(err),
    edit    : () => Promise.reject(err),
  };
}

describe('task logs', () => {
  it('records every reviewer call by attempt, and why the task stopped', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, config: { max_refine_attempts: 2 } });
    try {
      await p.run();
      await p.approve('aiko');
      const summary = await p.run({ reviewResponses: ['not json at all', BLOCKING] });
      const shot = summary.ran.find((t) => t.kind === 'shot_image')!;
      expect(shot.status).toBe('needs_human');

      const entries = await readTaskLog(p.paths.taskLog(shot.hash));
      const reviews = entries.filter((e) => e.t === 'review');
      expect(reviews.length).toBeGreaterThan(0);
      expect(new Set(reviews.map((r) => r.attempt))).toEqual(new Set([1, 2]));
      // The prompt is identical for every call, so it is written once and named by hash
      const systems = entries.filter((e) => e.t === 'system');
      expect(systems).toHaveLength(1);
      expect(reviews.every((r) => r.t === 'review' && r.system === systems[0]!.hash)).toBe(true);
      // The unparseable reply lands on whichever shot asked first; it is kept, and the retry
      // past it is a line of its own
      const shots = summary.ran.filter((t) => t.kind === 'shot_image');
      const all = (
        await Promise.all(shots.map((t) => readTaskLog(p.paths.taskLog(t.hash))))
      ).flat();
      expect(all.some((r) => r.t === 'review' && r.responses[0] === 'not json at all')).toBe(true);
      expect(
        all.some((e) => e.t === 'log' && e.level === 'retry' && e.source.startsWith('reviewer:')),
      ).toBe(true);
      const last = entries.at(-1)!;
      expect(last).toMatchObject({ t: 'log', level: 'info', source: 'scheduler' });
      expect(last.t === 'log' && last.text.startsWith('needs_human: ')).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it("keeps a thrown error's causes, with keys redacted", async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const cause = new Error(
        'GET https://example.test/v1/generate?key=AIzaSECRETSECRETSECRETSECRET123 403',
      );
      const summary = await p.run({ imageBackend: failingImages('the model exploded', cause) });
      const failed = summary.ran.find((t) => t.status === 'failed')!;
      const entries = await readTaskLog(p.paths.taskLog(failed.hash));
      const line = entries.find((e) => e.t === 'log' && e.level === 'error');
      expect(line?.t === 'log' && line.text).toBe(
        'failed: the model exploded — caused by GET https://example.test/v1/generate?key=<redacted> 403',
      );
    } finally {
      await p.cleanup();
    }
  }, 30_000);
});
