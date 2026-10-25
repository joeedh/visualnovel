/**
 * Carries a task's diagnostic log from the scheduler down to the provider calls that have
 * something to say. A provider call has no argument that could carry it, for the same reason
 * `reportingRetries` exists: image params are hashed into the task's identity, and a reviewer's
 * arguments are the picture and the spec.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TaskLogDraft, TaskLogLevel } from '@vn/types';

/** Where entries for one task execution go. Implementations never throw and never block. */
export interface TaskLogSink {
  append(draft: TaskLogDraft): void;
}

interface Scope {
  sink: TaskLogSink;
  source: string;
  attempt?: number;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Run `fn` with everything beneath it logging to `sink`. Calls made outside one log nothing. */
export function withTaskLog<T>(sink: TaskLogSink | undefined, fn: () => Promise<T>): Promise<T> {
  return sink ? scopes.run({ sink, source: 'provider' }, fn) : fn();
}

/**
 * Run `fn` with the source or attempt replaced for every entry written beneath it. Outside a
 * task log it only runs `fn`.
 */
export function withTaskLogScope<T>(
  over: { source?: string; attempt?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, ...over }, fn) : fn();
}

/** Appends one line under the current scope's source and attempt. */
export function noteTask(level: TaskLogLevel, text: string): void {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.sink.append({
    t: 'log',
    level,
    source: scope.source,
    text,
    ...(scope.attempt === undefined ? {} : { attempt: scope.attempt }),
  });
}

/** Appends one reviewer transcript, stamped with the current scope's attempt. */
export function noteReview(review: Omit<Extract<TaskLogDraft, { t: 'review' }>, 'attempt'>): void {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.sink.append({
    ...review,
    ...(scope.attempt === undefined ? {} : { attempt: scope.attempt }),
  });
}
