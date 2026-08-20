/**
 * Reading `vngen/state/commands.jsonl` back.
 *
 * The write is main's own — `onRecord` in `index.ts` appends each `CommandRecord` — so the read
 * lives beside it rather than in `@vn/commands`, which owns the record's shape and nothing about
 * where a host chooses to keep it.
 *
 * Nothing else in the app has needed this, because provenance was written to be read by a person
 * with a text editor. The difficult-agent report is the first reader in code, and it needs the
 * record of what was done, which a transcript does not carry.
 */
import { readFile } from 'node:fs/promises';
import type { CommandRecord } from '@vn/commands';
import type { ProjectPaths } from '@vn/store';
import { assemble, type Evidence, type ReportContext } from '@vn/agentreport';
import { readThread } from './threads.js';

/**
 * Every record the log holds that parses, in the order it was written.
 *
 * A crash mid-append leaves a half-written last line, and a line missing `seq` is not a record.
 * Both are skipped rather than thrown over, the same way a thread still lists when its final line
 * was cut short.
 */
export async function readCommandLog(paths: ProjectPaths): Promise<CommandRecord[]> {
  let text: string;
  try {
    text = await readFile(paths.commandsLog, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: CommandRecord[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const record = JSON.parse(raw) as CommandRecord;
      if (typeof record.seq === 'number') out.push(record);
    } catch {
      // A line that fails to parse was never finished being written
    }
  }
  return out;
}

/**
 * One conversation and the commands around it, ready for the analyst. The join itself is pure and
 * lives in `@vn/agentreport`; this is the half that touches disk.
 */
export async function evidenceFor(
  paths: ProjectPaths,
  threadId: string,
  context: ReportContext = {},
): Promise<Evidence> {
  const [thread, records] = await Promise.all([readThread(paths, threadId), readCommandLog(paths)]);
  return assemble(thread, records, context);
}
