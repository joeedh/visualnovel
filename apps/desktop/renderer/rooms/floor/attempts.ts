/**
 * The pure half of the refine-loop inspector: turn a task's recorded attempts into the
 * causal chain that actually ran. `shot_image` folds P7's generate → critique → refine into
 * one runner, so this is the only place the loop is legible.
 */
import type { Defect, DefectReport, Task, TaskAttempt } from '../../../src/shared/ipc';

/** A defect after merging: the same defect from two reviewers collapses, keeping both names. */
export interface MergedDefect extends Defect {
  reviewers: string[];
}

/** What became of one attempt. `pending` means the loop hasn't ruled on it yet. */
export type AttemptOutcome = 'accepted' | 'rejected' | 'failed' | 'pending';

const SEVERITY_RANK: Record<Defect['severity'], number> = { blocking: 0, major: 1, minor: 2 };

const defectKey = (d: Defect): string => `${d.severity}|${d.category}|${d.description}`;

/**
 * Flatten one attempt's reviews for display. `blocking` is computed exactly as `mergeReports`
 * in `@vn/providers` computes it — the UI must not disagree with the verdict the runner acted
 * on. Order is blocking-first via a *stable* sort, so within a severity the reviewers'
 * original order survives.
 *
 * The dedupe is display-only, and a real divergence from the runner: `mergeReports` keeps
 * both copies when two reviewers report the same defect, so the `Corrections:` clause can
 * name the same fix twice. Showing it twice would just look like a rendering bug.
 */
export function mergeAttemptReviews(reviews: DefectReport[]): {
  defects: MergedDefect[];
  blocking: boolean;
} {
  const flat = reviews.flatMap((r) => r.defects.map((d) => ({ defect: d, reviewer: r.reviewer })));
  const byKey = new Map<string, MergedDefect>();
  for (const { defect, reviewer } of flat) {
    const key = defectKey(defect);
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.reviewers.includes(reviewer)) seen.reviewers.push(reviewer);
    } else {
      byKey.set(key, { ...defect, reviewers: [reviewer] });
    }
  }
  const defects = [...byKey.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  return { defects, blocking: flat.some(({ defect }) => defect.severity === 'blocking') };
}

/**
 * The `Corrections:` clause `refinePrompt` added to produce `next` — the causal step between
 * two attempts, or null if there isn't one.
 *
 * A suffix diff would be wrong: `refinePrompt` strips any prior clause before appending the
 * new one, so attempt 3's clause *replaces* attempt 2's rather than extending it. Read the
 * clause off `next` directly instead of diffing.
 */
export function correctionDelta(prev: TaskAttempt | undefined, next: TaskAttempt): string | null {
  if (!next.prompt) return null;
  if (prev?.prompt === next.prompt) return null;
  const match = /\s*Corrections:\s*(.*)$/s.exec(next.prompt);
  const clause = match?.[1]?.trim();
  return clause ? clause : null;
}

/**
 * True when the loop re-ran on a byte-identical prompt. It happens for real: when every
 * reviewer repeats the same critique, `refinePrompt` strips the old `Corrections:` clause and
 * appends the same one, so nothing changed and the attempt could only burn the retry budget.
 * Worth naming in the UI, because a silent gap between two identical frames reads as a bug.
 */
export function promptRepeated(prev: TaskAttempt | undefined, next: TaskAttempt): boolean {
  return prev !== undefined && prev.prompt !== undefined && prev.prompt === next.prompt;
}

/**
 * Only the last attempt of a `done` task was accepted; every earlier attempt was rejected by
 * definition, because a later one exists. A task still in flight has ruled on nothing yet.
 */
export function attemptOutcome(task: Task, attempt: TaskAttempt, index: number): AttemptOutcome {
  if (attempt.error) return 'failed';
  if (index < task.attempts.length - 1) return 'rejected';
  if (task.status === 'done') return 'accepted';
  if (task.status === 'needs_human' || task.status === 'failed') return 'rejected';
  return 'pending';
}

/**
 * The defects still blocking when the loop gave up — the answer to "why `needs_human`".
 * Empty for any other status, since nothing survived a task that finished.
 */
export function survivingDefects(task: Task): MergedDefect[] {
  if (task.status !== 'needs_human' && task.status !== 'failed') return [];
  const last = task.attempts[task.attempts.length - 1];
  if (!last) return [];
  return mergeAttemptReviews(last.reviews).defects.filter((d) => d.severity === 'blocking');
}
