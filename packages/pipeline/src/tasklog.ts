import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskLogDraft, TaskLogEntry } from '@vn/types';
import { taskLogEntrySchema } from '@vn/types';
import type { TaskLogSink } from '@vn/providers';
import { checkRequestWrite } from '@vn/providers';
import { contract } from '@vn/contracts';
import { ensureDir, redactSecrets, sha256, writeFileAtomic } from '@vn/util';
import type { TaskRequests } from './requests.js';

/** Longest single text field kept; a reviewer reply or prompt past it is cut. */
export const TASKLOG_FIELD_MAX = 16_000;
/** Size past which a file drops its oldest execution on the next append. */
export const TASKLOG_MAX_BYTES = 2_000_000;

function clip(text: string): string {
  return text.length > TASKLOG_FIELD_MAX ? `${text.slice(0, TASKLOG_FIELD_MAX)}…` : text;
}

export const executionTaskLogDiagnostic = contract({
  id      : 'execution.taskLogDiagnostic',
  rule: 'Each task keeps a diagnostic log at `vngen/state/tasklogs/<hash>.jsonl`, gitignored because it holds full model prompts and replies. It is not provenance: writes are best effort, and a failed append never fails a task.',
  prevents:
    "Losing a provider retry, an unparsed reviewer reply or a thrown error's causes, failing a task because its diagnostics could not be written, or committing full prompts and replies to git.",
  subjects: [
    'function:packages/pipeline/src/tasklog.ts#TaskLogFile',
    'function:packages/pipeline/src/tasklog.ts#readTaskLog',
    'function:packages/providers/src/tasklog.ts#withTaskLog',
    'function:packages/pipeline/src/executors.ts#runTask',
    'command:pipeline.taskLog',
    'file:state/tasklogs',
  ],
  see: [
    'docs/plans/task-pane-logs.md',
    'docs/plans/contracts-into-code-and-workflows.md#stage-8-execution-contracts',
  ],
  detail:
    'The log records provider retries, reviewer replies that did not parse, the error that ' +
    'stopped the task (with its causes), and every reviewer call in full: the system prompt ' +
    '(stored once per file, by hash), the prompt, image hashes, raw replies, error and duration. ' +
    "A reviewer's parsed verdict is not repeated there; it stays on `Task.attempts[n].reviews`. " +
    'Each entry carries its execution (`checkpoint.id`) and its 1-based attempt index. Appends ' +
    'are serialized per execution and drained by an abort like any other write, and an append ' +
    'made after the owner abandoned the execution is dropped. Error text passes through ' +
    '`redactSecrets` (`@vn/util`) before it is written, and a text field longer than ' +
    '`TASKLOG_FIELD_MAX` is cut. A reviewer call answered from the response journal is not made ' +
    'again, so it writes no second entry; a call that was made again after a stop writes one, ' +
    'because it was a second paid call. Nothing deletes a log file: Clear finished deletes ' +
    'nothing, and a tombstone can be undone. A file past `TASKLOG_MAX_BYTES` drops its oldest ' +
    'other execution on the next append. Producers reach the log through `withTaskLog` in ' +
    '`@vn/providers`, an `AsyncLocalStorage` scope `runTask` opens around each runner with the ' +
    '`TaskLogFile` the scheduler creates for the execution. The Tasks pane reads it through ' +
    '`pipeline:taskLog`, which answers what the `pipeline.taskLog` command answers.',
});

/**
 * The task log of one execution, appended to `vngen/state/tasklogs/<hash>.jsonl`. Appends are
 * serialized, so reviewers running in parallel never interleave lines, and each is registered
 * with the execution's `TaskRequests` so an abort drains it before the task is released. An
 * append after the owner abandoned the task is dropped, as a late answer is.
 */
export class TaskLogFile implements TaskLogSink {
  private chain: Promise<void> = Promise.resolve();
  private systems: Promise<Set<string>> | undefined;

  constructor(
    private readonly file: string,
    private readonly execution: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly requests?: TaskRequests,
  ) {}

  append(draft: TaskLogDraft): void {
    try {
      checkRequestWrite();
      const entries = this.stamp(draft);
      const work = this.chain.then(() => this.write(entries)).catch(() => {});
      this.chain = work;
      void this.requests?.write(() => work);
    } catch {
      // A late append from an abandoned execution is dropped
    }
  }

  /** Resolves once every append so far has reached the file or failed. */
  settled(): Promise<void> {
    return this.chain;
  }

  private stamp(draft: TaskLogDraft): { system?: string; entry: TaskLogEntry } {
    const at = this.now();
    if (draft.t === 'log') {
      return {
        entry: { ...draft, execution: this.execution, at, text: clip(redactSecrets(draft.text)) },
      };
    }
    const { systemText, ...rest } = draft;
    return {
      system: systemText,
      entry: {
        ...rest,
        execution: this.execution,
        at,
        system   : sha256(systemText),
        prompt   : clip(rest.prompt),
        responses: rest.responses.map(clip),
        ...(rest.error === undefined ? {} : { error: clip(redactSecrets(rest.error)) }),
      },
    };
  }

  private async write({ system, entry }: { system?: string; entry: TaskLogEntry }): Promise<void> {
    const lines: TaskLogEntry[] = [];
    if (system !== undefined && entry.t === 'review') {
      const known = await (this.systems ??= this.knownSystems());
      if (!known.has(entry.system)) {
        known.add(entry.system);
        lines.push({ t: 'system', hash: entry.system, text: system });
      }
    }
    lines.push(entry);
    await ensureDir(dirname(this.file));
    await fs.appendFile(this.file, lines.map((line) => JSON.stringify(line) + '\n').join(''));
    const { size } = await fs.stat(this.file);
    if (size > TASKLOG_MAX_BYTES) await this.trim();
  }

  private async knownSystems(): Promise<Set<string>> {
    const entries = await readTaskLog(this.file);
    return new Set(entries.flatMap((e) => (e.t === 'system' ? [e.hash] : [])));
  }

  /** Drops the oldest execution other than this one, keeping every system prompt. */
  private async trim(): Promise<void> {
    const entries = await readTaskLog(this.file);
    const oldest = entries.find((e) => e.t !== 'system' && e.execution !== this.execution);
    if (!oldest || oldest.t === 'system') return;
    const kept = entries.filter((e) => e.t === 'system' || e.execution !== oldest.execution);
    await writeFileAtomic(this.file, kept.map((e) => JSON.stringify(e) + '\n').join(''));
  }
}

/**
 * Every entry in a task log, in file order. A line that does not parse (a truncated last line
 * from a killed process, or a shape a newer build wrote) is skipped; a missing file is empty.
 */
export async function readTaskLog(file: string): Promise<TaskLogEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries: TaskLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = taskLogEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // Not JSON: a torn write
    }
  }
  return entries;
}
