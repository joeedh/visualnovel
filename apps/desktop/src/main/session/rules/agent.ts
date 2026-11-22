import type { AgentBackend, AgentEvent, AgentMessage } from '@vn/authoring';
import type { ThreadHeader } from '../../notify/threads.js';

/** A backend that does no LLM work — lets the app run offline (mirrors the REPL's --mock). */
export class MockAgentBackend implements AgentBackend {
  readonly kind = 'mock';

  next(): Promise<{ final: string }> {
    return Promise.resolve({
      final:
        '[mock] No model is configured (running offline). I can read the workspace, but I ' +
        'cannot reason about edits without a model. Provide a key and switch off mock to use one.',
    });
  }
}

/** The four directories the project map is derived from — a write to any of them makes it stale. */
export const MAPPED_DIRS = ['characters/', 'locations/', 'scenes/', 'wiki/'];

/** Whether a finished turn wrote anything the project map is built out of. */
export function wroteAuthoredInput(events: readonly AgentEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === 'tool' &&
      (e.result.written ?? []).some((p) => MAPPED_DIRS.some((dir) => p.startsWith(dir))),
  );
}

/**
 * What a resumed conversation is told about the gap it is being continued across. Derived from the
 * header on every resume rather than written into the log, so a thread continued three times
 * carries one note rather than three.
 *
 * The second sentence is the load-bearing one: `edit_file` runs against a ledger of what this
 * conversation has read, and restoring the messages does not restore the ledger.
 */
export function resumedNote(header: ThreadHeader): AgentMessage {
  const archived = header.archived?.[header.archived.length - 1];
  const saved = archived ? ` It was last saved into git at ${archived.commit.slice(0, 8)}.` : '';
  return {
    role   : 'context',
    content:
      'This conversation was closed and has now been reopened, so the project may have changed ' +
      `since the messages above.${saved} Nothing read earlier in it still counts as read: read a ` +
      'file again before editing it.',
  };
}
