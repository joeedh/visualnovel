/**
 * What an author is offered when a call to the model fails, and how their answer reads back.
 *
 * This lives here rather than in either host because both ask the same question. The desktop draws
 * it as an ask card in the convo pane and `vnauthor` prints it as a numbered list, and neither
 * should invent its own set of choices. The loop is not involved: {@link ApiRecovery} has no
 * notion of a model, and turning "switch to gemini-2.5-pro" into a swapped backend is the host's
 * job, because only the host knows how to build one.
 */
import type { ApiFailure, AskQuestion } from './loop.js';

/**
 * How many attempts an author-chosen retry is worth. The failures worth retrying are rate limits
 * and 5xxs, which clear in seconds, so further attempts against anything else would not succeed.
 */
export const API_RETRIES = 10;

/**
 * What the author decided. `switch` and `report` are host actions; `retry` and `stop` are an
 * `ApiRecovery`. `report` stops the turn as well, so a host with nowhere to send a report can
 * treat it as `stop` and lose only the offer.
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
 * The question, with the failure quoted in it. The message is the provider's own, because a rate
 * limit and a rejected key want different answers and only that sentence says which this is.
 *
 * `transient` decides which advice is given. It is the fact the author needs and cannot read off
 * the message: a 429 clears on its own so retrying is right, while a refusal repeats itself.
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
    // The report leads the list wherever it is offered. It is offered for a `request` fault only,
    // where the provider read the body and rejected it, so retrying it and handing the same body to
    // another model both spend calls repeating what went wrong. Stop stays last either way.
    choices: [
      ...(offersReport(failure) ? [REPORT_CHOICE] : []),
      RETRY_CHOICE,
      ...others.map(switchChoice),
      STOP_CHOICE,
    ],
  };
}

/**
 * Whether looking into it is worth offering.
 *
 * True only for a `request` fault, where the provider read what was sent and rejected it, which is
 * the one class in which the request itself is the evidence. A rate limit has nothing to diagnose,
 * a rejected key wants the key dialog, and `unknown` would produce false positives, so offering on
 * those would teach the author to dismiss the offer.
 */
export function offersReport(failure: ApiFailure): boolean {
  return failure.kind === 'request';
}

/**
 * Read an answer back. An unrecognised answer becomes `stop` deliberately, because an answer that
 * cannot be parsed is not permission to spend `API_RETRIES` more calls on the author's key.
 */
export function readApiPlan(answer: string, others: readonly string[]): ApiPlan {
  const said = answer.trim().toLowerCase();
  if (!said) return { do: 'stop' };
  if (said === RETRY_CHOICE.toLowerCase() || /^retry\b/.test(said)) {
    return { do: 'retry', times: API_RETRIES };
  }
  // Read before the model search: the report row names no model, and a typed answer that does
  // name one ("look into what gemini did") is still asking to diagnose rather than to switch
  if (said === REPORT_CHOICE.toLowerCase() || /\blook into\b/.test(said)) {
    return { do: 'report' };
  }
  // A model is looked for anywhere in the answer, so the picked row, a typed id and "switch to
  // gemini-2.5-pro please" all land in the same place.
  const model = others.find((m) => said.includes(m.toLowerCase()));
  if (model) return { do: 'switch', model };
  return { do: 'stop' };
}
