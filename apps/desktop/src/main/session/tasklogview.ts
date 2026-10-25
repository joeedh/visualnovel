import type { AnyTask, TaskLogEntry, TaskLogLine, TaskLogReview } from '@vn/types';
import type { TaskLogView } from '../../shared/ipc.js';

const byTime = <T extends { at: string }>(a: T, b: T): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : 0;

/**
 * Failures the task record holds that the log file does not: every attempt error older than the
 * file's first entry, and `task.error` when no attempt already says it. The scheduler writes a
 * thrown error to both, so without the second rule each failure would show twice.
 */
function recovered(task: AnyTask | undefined, since: string | undefined): TaskLogLine[] {
  if (!task) return [];
  const lines: TaskLogLine[] = [];
  task.attempts.forEach((attempt, index) => {
    if (!attempt.error) return;
    const at = attempt.at ?? '';
    if (since !== undefined && at >= since) return;
    lines.push({
      t        : 'log',
      execution: '',
      at,
      level  : 'error',
      source : 'record',
      text   : attempt.error,
      attempt: index + 1,
    });
  });
  const said = task.attempts.at(-1)?.error;
  if (task.error && task.error !== said && since === undefined) {
    lines.push({
      t        : 'log',
      execution: '',
      at       : task.attempts.at(-1)?.at ?? '',
      level    : task.status === 'failed' ? 'error' : 'info',
      source   : 'record',
      text     : `${task.status}: ${task.error}`,
    });
  }
  return lines;
}

/** Builds the pane's view of one task's log from the file's entries and the task's record. */
export function taskLogView(
  hash: string,
  entries: readonly TaskLogEntry[],
  task: AnyTask | undefined,
): TaskLogView {
  const systems = new Map<string, string>();
  const lines: TaskLogLine[] = [];
  const reviews: TaskLogReview[] = [];
  for (const entry of entries) {
    if (entry.t === 'system') systems.set(entry.hash, entry.text);
    else if (entry.t === 'log') lines.push(entry);
    else reviews.push(entry);
  }
  const first = [...lines, ...reviews].map((e) => e.at).sort()[0];
  return {
    hash,
    lines  : [...recovered(task, first), ...lines].sort(byTime),
    reviews: reviews
      .sort(byTime)
      .map((review) => ({ ...review, systemText: systems.get(review.system) ?? '' })),
  };
}
