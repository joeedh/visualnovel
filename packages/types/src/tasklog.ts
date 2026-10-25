/**
 * The per-task diagnostic log, `vngen/state/tasklogs/<hash>.jsonl`: what happened while a task
 * ran that its record in `tasks.jsonl` does not keep — provider retries, unparseable model
 * replies, the error a runner threw, and each reviewer call in full. The file is local and
 * gitignored, written best effort, and is never provenance.
 */
import { z } from 'zod';

export const taskLogLevelSchema = z.enum(['info', 'retry', 'error']);
export type TaskLogLevel = z.infer<typeof taskLogLevelSchema>;

/** One sentence about the task, from the scheduler, the runner, a provider or a reviewer. */
export const taskLogLineSchema = z.object({
  t        : z.literal('log'),
  /** The `checkpoint.id` of the execution that wrote it; two runs of one hash differ here. */
  execution: z.string(),
  at       : z.string(),
  level    : taskLogLevelSchema,
  /** `scheduler`, `runner`, `provider`, or `reviewer:<id>`. */
  source   : z.string(),
  text     : z.string(),
  /** 1-based position in `Task.attempts` this line belongs to, when it belongs to one. */
  attempt  : z.number().int().positive().optional(),
});
export type TaskLogLine = z.infer<typeof taskLogLineSchema>;

/** A reviewer system prompt, written once per file and named by hash from each review. */
export const taskLogSystemSchema = z.object({
  t   : z.literal('system'),
  hash: z.string(),
  text: z.string(),
});
export type TaskLogSystem = z.infer<typeof taskLogSystemSchema>;

/** An image a reviewer was shown: a stored asset, or bytes that never entered the store. */
export const taskLogImageSchema = z.object({
  hash  : z.string(),
  ext   : z.string().optional(),
  inline: z.literal(true).optional(),
});
export type TaskLogImage = z.infer<typeof taskLogImageSchema>;

/**
 * One reviewer call in full. The parsed verdict is not repeated here; it is on the matching
 * `Task.attempts[attempt - 1].reviews`, under the same reviewer id.
 */
export const taskLogReviewSchema = z.object({
  t        : z.literal('review'),
  execution: z.string(),
  at       : z.string(),
  attempt  : z.number().int().positive().optional(),
  reviewer : z.string(),
  model    : z.string().optional(),
  /** Hash of a `system` entry in the same file. */
  system   : z.string(),
  prompt   : z.string(),
  images   : z.array(taskLogImageSchema),
  /** Raw model text, one per structured try; all but a successful last one failed to parse. */
  responses: z.array(z.string()),
  error    : z.string().optional(),
  ms       : z.number(),
});
export type TaskLogReview = z.infer<typeof taskLogReviewSchema>;

export const taskLogEntrySchema = z.discriminatedUnion('t', [
  taskLogLineSchema,
  taskLogSystemSchema,
  taskLogReviewSchema,
]);
export type TaskLogEntry = z.infer<typeof taskLogEntrySchema>;

/**
 * What a producer hands the sink: the sink stamps `execution` and `at`, and turns the system
 * prompt's text into a hash.
 */
export type TaskLogDraft =
  | Omit<TaskLogLine, 'execution' | 'at'>
  | (Omit<TaskLogReview, 'execution' | 'at' | 'system'> & { systemText: string });
