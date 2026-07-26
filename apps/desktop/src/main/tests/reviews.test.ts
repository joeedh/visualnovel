/**
 * The narrowing that lets the renderer treat `reviews` as `DefectReport[]`. Everything here
 * is about the ragged case: `tasks.jsonl` is append-only JSON written across runs, so an
 * attempt's reviews can be anything at all by the time the inspector reads them.
 */
import type { AnyTask, DefectReport } from '@vn/types';
import { narrowTask } from '../reviews.js';

const report = (reviewer: string, severity: 'blocking' | 'major' | 'minor'): DefectReport => ({
  reviewer,
  defects: [{ severity, category: 'hair', description: 'wrong color', suggestedFix: 'use auburn' }],
});

const taskWith = (reviews: unknown[] | undefined): AnyTask =>
  ({
    hash: 'abc123',
    kind: 'shot_image',
    deps: [],
    inputs: { shotId: 'arrival__establishing', prompt: 'a room', refs: [], params: {} },
    status: 'needs_human',
    attempts: [{ attempt: 1, refs: [], output: 'deadbeef', reviews }],
  }) as unknown as AnyTask;

const reviewsOf = (reviews: unknown[] | undefined): DefectReport[] =>
  narrowTask(taskWith(reviews)).attempts[0]?.reviews ?? [];

describe('narrowTask', () => {
  it('keeps well-formed reports', () => {
    expect(reviewsOf([report('gemini', 'blocking')])).toEqual([report('gemini', 'blocking')]);
  });

  it('drops only the malformed entries, keeping their neighbours', () => {
    const reviews = reviewsOf([
      report('gemini', 'blocking'),
      { reviewer: 'claude', defects: [{ severity: 'catastrophic' }] },
      null,
      'not an object',
      report('claude', 'minor'),
    ]);
    expect(reviews.map((r) => r.reviewer)).toEqual(['gemini', 'claude']);
  });

  it('defaults a missing defects array rather than dropping the report', () => {
    expect(reviewsOf([{ reviewer: 'gemini' }])).toEqual([{ reviewer: 'gemini', defects: [] }]);
  });

  it('yields an empty array for absent or non-array reviews', () => {
    expect(reviewsOf(undefined)).toEqual([]);
    expect(reviewsOf({ oops: true } as unknown as unknown[])).toEqual([]);
  });

  it('stamps the stored extension on the attempt when the manifest knows it', () => {
    const t = narrowTask(taskWith([]), (hash) => (hash === 'deadbeef' ? 'webp' : undefined));
    expect(t.attempts[0]?.outputExt).toBe('webp');
  });

  it('omits outputExt when the asset is not in the manifest', () => {
    expect(narrowTask(taskWith([]), () => undefined).attempts[0]?.outputExt).toBeUndefined();
    expect(narrowTask(taskWith([])).attempts[0]?.outputExt).toBeUndefined();
  });

  it('leaves every other field of the task alone', () => {
    const t = narrowTask(taskWith([report('gemini', 'major')]));
    expect(t.hash).toBe('abc123');
    expect(t.status).toBe('needs_human');
    expect(t.attempts[0]?.output).toBe('deadbeef');
  });
});
