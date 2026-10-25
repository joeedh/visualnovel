import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskLogDraft, TaskLogEntry } from '@vn/types';
import { taskLogEntrySchema } from '@vn/types';
import type { TaskLogSink } from '@vn/providers';
import { checkRequestWrite } from '@vn/providers';
import { ensureDir, redactSecrets, sha256, writeFileAtomic } from '@vn/util';
import type { TaskRequests } from './requests.js';

/** Longest single text field kept; a reviewer reply or prompt past it is cut. */
export const TASKLOG_FIELD_MAX = 16_000;
/** Size past which a file drops its oldest execution on the next append. */
export const TASKLOG_MAX_BYTES = 2_000_000;

function clip(text: string): string {
  return text.length > TASKLOG_FIELD_MAX ? `${text.slice(0, TASKLOG_FIELD_MAX)}…` : text;
}

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
