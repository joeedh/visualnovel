/**
 * Whether a saved conversation can be continued, and the sentence saying why not.
 *
 * Shared rather than kept beside the store in `main/threads.ts` because the Convo pane greys its
 * Continue button on this and main refuses `agent.resumeThread` on it, and a greyed control has to
 * say what the command would say.
 */
import { chatVendorFor } from '@vn/types';
import type { ChatVendor } from '@vn/types';
// Type-only, for the reason `convo.ts` gives: `@vn/authoring` reads the filesystem, and this shape
// is named here only as data that has already crossed the wire.
import type { BackendKind } from '@vn/authoring';
import type { ResumeHeader, ThreadRecord } from './convo.js';

/**
 * The native log's format version, written at line 0. A log carrying a higher one was written by a
 * newer build and is refused rather than read on a guess.
 */
export const NATIVE_VERSION = 1;

/**
 * What a thread's stored history says about continuing it. A thread recorded before the native log
 * existed has neither field.
 */
export interface ResumeState {
  /** Line 0 of the native log. */
  header?: ResumeHeader;
  /** Set when the log could not be read intact — today, a merge resolved into the file. */
  damaged?: boolean;
}

/**
 * A saved conversation put on screen: everything the transcript holds, plus what its history says
 * about continuing it. The pane keeps the second half so the Continue button can be re-decided when
 * the author binds a different model, without reopening the thread.
 */
export interface OpenedThread extends ThreadRecord {
  resume: ResumeState;
}

/**
 * What the agent is bound to now, which is what a stored conversation is checked against.
 *
 * `backend` is what main knows and the renderer does not: only a built backend says which protocol
 * it speaks. The pane therefore runs the first four checks and main runs all five.
 */
export interface ResumeBinding {
  model: string;
  backend?: BackendKind;
}

/** How each protocol reads in a refusal. */
const BACKENDS: Record<BackendKind, string> = {
  native: 'the native tool-calling path',
  structured: 'the text tool-calling path',
  mock: 'a mock backend',
};

/** How each vendor reads in a refusal, as the author would name it rather than as an api key does. */
const VENDORS: Record<ChatVendor, string> = { anthropic: 'Claude', gemini: 'Gemini' };

/**
 * Why this conversation cannot be continued on the binding in force, or `undefined`.
 *
 * The damaged check runs first because a damaged log yields no header to check anything else
 * against. The vendor and backend checks are skipped while no model is bound, since there is
 * nothing to compare the stored one to.
 */
export function resumeRefusal(
  title: string,
  state: ResumeState,
  bound: ResumeBinding,
): string | undefined {
  const named = `“${title}”`;
  const reading = 'Open it for reading instead.';
  if (state.damaged) {
    return `${named}'s history was merged from two copies and is no longer intact. ${reading}`;
  }
  const header = state.header;
  if (!header) {
    return (
      `${named} was recorded before conversations could be continued, so only its transcript ` +
      `was kept. ${reading}`
    );
  }
  if (header.v > NATIVE_VERSION) {
    return (
      `${named} was written by a newer version of VN Studio and cannot be continued here. ` +
      reading
    );
  }
  if (!bound.model) return undefined;

  if (header.vendor !== chatVendorFor(bound.model)) {
    return (
      `${named} was recorded on ${header.model ?? VENDORS[header.vendor]} and the agent is bound ` +
      `to ${bound.model}. The two vendors do not share a message format, so continuing would ` +
      `send blocks the model cannot read. Bind a ${VENDORS[header.vendor]} model first, or open ` +
      'the conversation for reading.'
    );
  }
  if (bound.backend && header.backend !== bound.backend) {
    return (
      `${named} was recorded through ${BACKENDS[header.backend]}, which ${bound.model} does not ` +
      'offer. Continuing would drop every tool call and result from the history. ' +
      'Open the conversation for reading instead.'
    );
  }
  return undefined;
}

/**
 * What a resume changes about the binding, when it is allowed but not on the model the conversation
 * was recorded with. `agent.setModel` already promises a hot swap keeps conversation state, so a
 * sibling model is no worse than what the app permits mid-conversation, and the author is told which
 * swap they are making rather than stopped.
 */
export function resumeNote(state: ResumeState, bound: ResumeBinding): string | undefined {
  const was = state.header?.model;
  if (!was || !bound.model || was === bound.model) return undefined;
  return `Recorded on ${was}, continuing on ${bound.model}.`;
}
