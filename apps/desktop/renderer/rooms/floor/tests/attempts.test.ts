/**
 * Fixtures here mirror a real three-attempt `shot_image` run: `refinePrompt`
 * (`packages/pipeline/src/p6.ts`) strips the prior `Corrections:` clause before appending a
 * new one, so attempt 3's prompt is base + clause-3, *not* base + clause-2 + clause-3. That
 * strip-and-replace is the case a naive suffix diff gets wrong.
 */
import type { DefectReport, Task, TaskAttempt } from '../../../../src/shared/ipc';
import {
  attemptOutcome,
  correctionDelta,
  mergeAttemptReviews,
  promptRepeated,
  survivingDefects,
  triageOf,
} from '../attempts';

const BASE = 'A quiet dormitory room at dusk, wide shot.';

const defect = (
  severity: 'blocking' | 'major' | 'minor',
  category: string,
  description: string,
  suggestedFix?: string,
) => ({ severity, category, description, ...(suggestedFix ? { suggestedFix } : {}) });

const review = (reviewer: string, ...defects: ReturnType<typeof defect>[]): DefectReport => ({
  reviewer,
  defects,
});

const attempt = (n: number, prompt: string, output: string, reviews: DefectReport[]): TaskAttempt =>
  ({ attempt: n, prompt, refs: [], output, reviews }) as TaskAttempt;

/** Three attempts: two blocked, the third clean — the shape the runner produces. */
const threeAttempts: TaskAttempt[] = [
  attempt(1, BASE, 'aaa11111', [
    review(
      'gemini',
      defect('blocking', 'hair', 'hair is black, should be auburn', 'use auburn hair'),
      defect('minor', 'framing', 'subject slightly centered'),
    ),
  ]),
  attempt(2, `${BASE} Corrections: use auburn hair.`, 'bbb22222', [
    review('gemini', defect('blocking', 'lighting', 'noon light, not dusk', 'warm dusk light')),
  ]),
  attempt(3, `${BASE} Corrections: warm dusk light.`, 'ccc33333', [review('gemini')]),
];

const task = (status: Task['status'], attempts: TaskAttempt[]): Task =>
  ({ hash: 'abc123', kind: 'shot_image', deps: [], status, attempts }) as unknown as Task;

describe('mergeAttemptReviews', () => {
  it('sorts blocking first and keeps within-severity order stable', () => {
    const { defects } = mergeAttemptReviews([
      review(
        'gemini',
        defect('minor', 'framing', 'a'),
        defect('blocking', 'hair', 'b'),
        defect('minor', 'grain', 'c'),
        defect('major', 'outfit', 'd'),
      ),
    ]);
    expect(defects.map((d) => d.category)).toEqual(['hair', 'outfit', 'framing', 'grain']);
  });

  it('collapses the same defect from two reviewers, keeping both names', () => {
    const { defects } = mergeAttemptReviews([
      review('gemini', defect('blocking', 'hair', 'wrong color')),
      review('claude', defect('blocking', 'hair', 'wrong color')),
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]?.reviewers).toEqual(['gemini', 'claude']);
  });

  it('agrees with the runner on `blocking`', () => {
    expect(mergeAttemptReviews([review('gemini', defect('major', 'x', 'y'))]).blocking).toBe(false);
    expect(mergeAttemptReviews([review('gemini', defect('blocking', 'x', 'y'))]).blocking).toBe(
      true,
    );
    expect(mergeAttemptReviews([]).blocking).toBe(false);
  });

  it('treats a reviewer that found nothing as clean, not missing', () => {
    expect(mergeAttemptReviews([review('gemini')])).toEqual({ defects: [], blocking: false });
  });
});

describe('correctionDelta', () => {
  it('is null for the first attempt — nothing caused it', () => {
    expect(correctionDelta(undefined, threeAttempts[0] as TaskAttempt)).toBeNull();
  });

  it('reads the clause that caused the next attempt', () => {
    expect(correctionDelta(threeAttempts[0], threeAttempts[1] as TaskAttempt)).toBe(
      'use auburn hair.',
    );
  });

  it('survives strip-and-replace: attempt 3 shows its own clause, not both', () => {
    const delta = correctionDelta(threeAttempts[1], threeAttempts[2] as TaskAttempt);
    expect(delta).toBe('warm dusk light.');
    expect(delta).not.toContain('auburn');
  });

  // Verbatim from a recorded run: `refinePrompt` joins every merged defect with '; ', names
  // the ones with no `suggestedFix` as "fix <category>: <description>", and ends with a '.'
  // that lands next to the description's own — hence the doubled period.
  it('keeps a real multi-defect clause intact', () => {
    const clause =
      'remove the extra limb; single vanishing point; fix grain: Slight noise in the shadows..';
    const next = attempt(2, `${BASE} Corrections: ${clause}`, 'bbb', []);
    expect(correctionDelta(threeAttempts[0], next)).toBe(clause);
  });

  it('is null when the prompt did not change', () => {
    const a = attempt(1, BASE, 'aaa', []);
    expect(correctionDelta(a, attempt(2, BASE, 'bbb', []))).toBeNull();
  });

  it('is null when the prompt changed without a corrections clause', () => {
    const a = attempt(1, BASE, 'aaa', []);
    expect(correctionDelta(a, attempt(2, 'something else entirely', 'bbb', []))).toBeNull();
  });

  it('is null when no prompt was recorded', () => {
    expect(correctionDelta(undefined, { attempt: 1, refs: [], reviews: [] } as TaskAttempt)).toBe(
      null,
    );
  });
});

describe('promptRepeated', () => {
  // Observed in a real run: both reviewers repeated their critique verbatim, so the rebuilt
  // `Corrections:` clause was identical and attempts 2 and 3 even produced the same image.
  it('flags a retry that changed nothing', () => {
    const clause = `${BASE} Corrections: remove the extra limb.`;
    expect(promptRepeated(attempt(2, clause, 'x', []), attempt(3, clause, 'x', []))).toBe(true);
  });

  it('is false for the first attempt and for a real refinement', () => {
    expect(promptRepeated(undefined, threeAttempts[0] as TaskAttempt)).toBe(false);
    expect(promptRepeated(threeAttempts[1], threeAttempts[2] as TaskAttempt)).toBe(false);
  });
});

describe('attemptOutcome', () => {
  it('accepts only the last attempt of a done task', () => {
    const t = task('done', threeAttempts);
    expect(threeAttempts.map((a, i) => attemptOutcome(t, a, i))).toEqual([
      'rejected',
      'rejected',
      'accepted',
    ]);
  });

  it('accepts nothing on a needs_human task', () => {
    const t = task('needs_human', threeAttempts);
    expect(threeAttempts.map((a, i) => attemptOutcome(t, a, i))).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
  });

  it('leaves the in-flight attempt unjudged', () => {
    const t = task('running', [threeAttempts[0] as TaskAttempt]);
    expect(attemptOutcome(t, threeAttempts[0] as TaskAttempt, 0)).toBe('pending');
  });

  it('reports an errored attempt as failed regardless of position', () => {
    const errored = { ...(threeAttempts[2] as TaskAttempt), error: 'provider timeout' };
    expect(attemptOutcome(task('done', [errored]), errored, 0)).toBe('failed');
  });
});

describe('survivingDefects', () => {
  it('names what was still blocking when the loop gave up', () => {
    const blocked = [
      threeAttempts[0] as TaskAttempt,
      threeAttempts[1] as TaskAttempt,
      attempt(3, `${BASE} Corrections: warm dusk light.`, 'ccc33333', [
        review(
          'claude',
          defect('blocking', 'lighting', 'still noon light'),
          defect('minor', 'grain', 'slightly soft'),
        ),
      ]),
    ];
    const survived = survivingDefects(task('needs_human', blocked));
    expect(survived.map((d) => d.category)).toEqual(['lighting']);
    expect(survived[0]?.reviewers).toEqual(['claude']);
  });

  it('is empty for a task that finished cleanly', () => {
    expect(survivingDefects(task('done', threeAttempts))).toEqual([]);
  });

  it('is empty when a failed task recorded no attempts', () => {
    expect(survivingDefects(task('failed', []))).toEqual([]);
  });
});

describe('triageOf', () => {
  const blocked = [
    threeAttempts[0] as TaskAttempt,
    attempt(2, `${BASE} Corrections: warm dusk light.`, 'ccc', [
      review('claude', defect('blocking', 'lighting', 'still noon light')),
    ]),
  ];
  const errored = (error?: string): Task => ({
    ...task('failed', []),
    ...(error ? { error } : {}),
  });

  it('says nothing about a task that is still running or finished cleanly', () => {
    expect(triageOf(task('done', threeAttempts))).toBeNull();
    expect(triageOf(task('running', []))).toBeNull();
  });

  it('names the defects that survived a needs_human loop, not the reason string', () => {
    const t = { ...task('needs_human', blocked), error: 'attempt 2 still has blocking defects' };
    const triage = triageOf(t);
    expect(triage?.headline).toBe('⚑ needs_human — still blocking after 2 attempts');
    expect(triage?.defects.map((d) => d.category)).toEqual(['lighting']);
    expect(triage?.reason).toBeNull();
  });

  // A task that threw has neither reviews nor defects, so `error` is the only account of it.
  it('falls back to the recorded reason when nothing blocking survived', () => {
    const triage = triageOf(errored('the model exploded'));
    expect(triage?.headline).toBe('✕ failed — no asset produced after 0 attempts');
    expect(triage?.defects).toEqual([]);
    expect(triage?.reason).toBe('the model exploded');
  });

  it('admits it when no reason was recorded at all', () => {
    expect(triageOf(errored())?.reason).toBe('No reason was recorded.');
    expect(triageOf(task('needs_human', []))?.reason).toBe(
      'No blocking defect was recorded on the last attempt.',
    );
  });

  it('counts one attempt in the singular', () => {
    const t = { ...errored('boom'), attempts: [threeAttempts[0] as TaskAttempt] };
    expect(triageOf(t)?.headline).toBe('✕ failed — no asset produced after 1 attempt');
  });
});
