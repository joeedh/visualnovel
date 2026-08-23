/**
 * Compaction: replacing what a conversation has already said with a summary of it, so a long
 * conversation can carry on without resending every turn. Both functions here are pure — the
 * model call is one `AgentBackend.next` the host makes, so this module has no opinion about
 * which backend answers it or what it costs.
 */
import type { AgentMessage } from './backend.js';
import { renderTranscript } from './backend.js';
import { lastCompleteTurn } from './loop.js';

/** The system prompt of the summarizing call. */
export const COMPACTION_SYSTEM =
  'You are summarizing a conversation between an author and the writing assistant helping them ' +
  'build a visual novel, so that the assistant can carry on with a shorter record of it. Write ' +
  'for the assistant, not for the author.';

const TASK =
  'Summarize the conversation below so that it can be continued from the summary alone. Write ' +
  'four short sections: WHAT THE AUTHOR WANTS (their goal, and any standing instruction or ' +
  'preference they have stated), WHAT HAS BEEN DONE (files written, assets generated, decisions ' +
  'settled), WHERE IT STANDS (what was in progress, and what the next step was going to be), and ' +
  'STILL OPEN (questions asked and not answered, and anything refused or deferred). Name files, ' +
  'scenes, characters and ids exactly as they appear. Record each decision and the reason for it ' +
  'rather than retelling the dialogue that reached it. Answer with the summary and nothing else.';

/**
 * The one request that summarizes `messages`. A single `user` message carrying the rendered
 * transcript, so the call is the same on either protocol and cannot dangle a tool call.
 */
export function compactionPrompt(messages: readonly AgentMessage[]): AgentMessage[] {
  return [{ role: 'user', content: `${TASK}\n\nCONVERSATION:\n\n${renderTranscript(messages)}` }];
}

// Read before the summary. The read ledger goes with the messages, so a file the agent read
// before a compaction counts as unread after it.
const PREFACE =
  'Everything said in this conversation before this point has been replaced by the summary ' +
  'below, to save room. Nothing you read earlier still counts as read: read a file again before ' +
  'you edit it.';

/**
 * The message a summary is carried as. `context` rather than `user`, so the agent does not read
 * it as something the author typed.
 */
export function compactionMessage(summary: string): AgentMessage {
  return { role: 'context', content: `${PREFACE}\n\n${summary}` };
}

/**
 * The transcript a compaction leaves behind: the summary, then whatever came after the cut.
 * The cut is the last index the conversation may be divided at, so a tool call and its result
 * are never separated and the tail never opens on an observation. Answers that index, which is
 * what the record of the compaction states its range in.
 */
export function compactRange(
  messages: readonly AgentMessage[],
  summary: string,
): { messages: AgentMessage[]; to: number } {
  const to = lastCompleteTurn(messages);
  return { messages: [compactionMessage(summary), ...messages.slice(to + 1)], to };
}
