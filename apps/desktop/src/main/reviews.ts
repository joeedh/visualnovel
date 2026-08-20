/**
 * Boundary validation for task provenance. `TaskAttempt.reviews` is `unknown[]` because it
 * comes back off `tasks.jsonl` as JSON; this is where it becomes `DefectReport[]` for the
 * renderer. The log is most likely to be malformed when a task has failed, so a malformed entry is
 * dropped rather than throwing, and the inspector shows "no critique recorded".
 */
import { defectReportSchema, type DefectReport, type Task as PipelineTask } from '@vn/types';
import type { Task } from '../shared/ipc.js';

/** Keep only the entries that parse, so a bad entry costs its own review rather than the attempt. */
function narrowReviews(reviews: unknown[] | undefined): DefectReport[] {
  if (!Array.isArray(reviews)) return [];
  const out: DefectReport[] = [];
  for (const raw of reviews) {
    const parsed = defectReportSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Project one pipeline task into the shape the renderer's IPC contract promises.
 * `extOf` resolves an output hash to its stored extension (the manifest); without one the
 * attempt carries no `outputExt` and the renderer shows structure with no thumbnail.
 */
export function narrowTask(task: PipelineTask, extOf?: (hash: string) => string | undefined): Task {
  return {
    ...task,
    attempts: task.attempts.map((a) => {
      const ext = a.output ? extOf?.(a.output) : undefined;
      return { ...a, reviews: narrowReviews(a.reviews), ...(ext ? { outputExt: ext } : {}) };
    }),
  };
}
