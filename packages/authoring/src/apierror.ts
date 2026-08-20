/**
 * What an author is offered when a call to the model fails, and how their answer reads back.
 *
 * Here rather than in either host because both put the same question: the desktop draws it as an
 * ask card in the convo pane, `vnauthor` prints it as a numbered list, and neither should invent
 * its own idea of what the choices are. The loop stays out of it — {@link ApiRecovery} has no
 * notion of a model, and turning "switch to gemini-2.5-pro" into a swapped backend is the host's
 * job, because the host is the only thing that knows how to build one.
 */
import type { ApiFailure, AskQuestion } from './loop.js';

/**
 * How many attempts an author-chosen retry is worth. Ten, because the failures worth retrying are
 * rate limits and 5xxs — both of which clear in seconds — and an eleventh attempt against
 * anything else is just a slower way of finding out it was never going to work.
 */
export const API_RETRIES = 10;

/**
 * What the author decided. `switch` and `report` are host actions; the other two are an
 * `ApiRecovery` — and `report` stops the turn as well, so a host with nowhere to send a report can
 * treat it as `stop` and lose nothing but the offer.
 */
export type ApiPlan =
  | { do: 'retry'; times: number }
  | { do: 'switch'; model: string }
  | { do: 'report' }
  | { do: 'stop' };

const RETRY_CHOICE = `Retry automatically, up to ${API_RETRIES} times`;
const STOP_CHOICE = 'Stop this turn';
const REPORT_CHOICE = 'Stop, and look into what went wrong';

/** How switching to `model` reads in the list, and the string an answer is matched against. */
export function switchChoice(model: string): string {
  return `Switch to ${model} and try again`;
}

/**
 * The question, with the failure quoted in it. The message is the provider's own — a rate limit
 * and a rejected key want different answers, and only the sentence it sent says which this is.
 *
 * `transient` decides which advice is given, because it is the one fact the author needs and the
 * one they cannot read off the message: a 429 clears on its own and retrying is right, while a
 * refusal will say the same thing ten times.
 */
export function apiRecoveryQuestion(
  failure: ApiFailure,
  model: string,
  others: readonly string[],
): AskQuestion {
  const advice = failure.transient
    ? 'This looks temporary — a rate limit, or the provider having a bad minute — so trying ' +
      'again will probably work.'
    : 'This does not look temporary, so another attempt will most likely fail the same way. ' +
      'Another provider might not.';
  return {
    question:
      `${model || 'The model'} failed: ${failure.message}\n\n${advice}\n\n` +
      'What should I do? The conversation so far is kept either way.',
    choices: [
      RETRY_CHOICE,
      ...others.map(switchChoice),
      ...(offersReport(failure) ? [REPORT_CHOICE] : []),
      STOP_CHOICE,
    ],
  };
}

/**
 * Whether looking into it is worth offering.
 *
 * Only a `request` fault: the provider read what was sent and rejected it, which is the one class
 * where the request itself is the evidence. A rate limit has nothing to diagnose, a rejected key
 * wants the key dialog, and `unknown` is where a false positive lives — an offer on every odd
 * failure teaches the author to dismiss the offer.
 */
export function offersReport(failure: ApiFailure): boolean {
  return failure.kind === 'request';
}

/**
 * Read an answer back. Anything unrecognised is `stop`, deliberately: an answer nobody can parse
 * is not permission to spend ten more calls on the author's key.
 */
export function readApiPlan(answer: string, others: readonly string[]): ApiPlan {
  const said = answer.trim().toLowerCase();
  if (!said) return { do: 'stop' };
  if (said === RETRY_CHOICE.toLowerCase() || /^retry\b/.test(said)) {
    return { do: 'retry', times: API_RETRIES };
  }
  // Read before the model search, because the row names no model while a typed answer that does
  // ("look into what gemini did") is asking to diagnose rather than to switch.
  if (said === REPORT_CHOICE.toLowerCase() || /\blook into\b/.test(said)) {
    return { do: 'report' };
  }
  // A model is looked for anywhere in the answer, so the picked row, a typed id and "switch to
  // gemini-2.5-pro please" all land in the same place.
  const model = others.find((m) => said.includes(m.toLowerCase()));
  if (model) return { do: 'switch', model };
  return { do: 'stop' };
}
