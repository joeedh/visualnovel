/**
 * The question both hosts put when a model call fails, and how an answer reads back. The reading
 * is the part worth pinning: a desktop ask card returns the row verbatim, `vnauthor` returns
 * whatever the author typed, and both land in the same three plans.
 */
import { API_RETRIES, apiRecoveryQuestion, readApiPlan, switchChoice } from '../index.js';
import type { ApiFailure } from '../index.js';

const OTHERS = ['gemini-2.5-pro', 'gpt-5'];

const failure = (over: Partial<ApiFailure> = {}): ApiFailure => ({
  message: '429 rate limited',
  transient: true,
  attempt: 1,
  waitMs: 1_000,
  ...over,
});

describe('the question', () => {
  it('quotes the provider and offers every model but the one that failed', () => {
    const q = apiRecoveryQuestion(failure(), 'claude-opus-4', OTHERS);
    expect(q.question).toContain('claude-opus-4');
    expect(q.question).toContain('429 rate limited');
    expect(q.choices).toEqual([
      `Retry automatically, up to ${API_RETRIES} times`,
      switchChoice('gemini-2.5-pro'),
      switchChoice('gpt-5'),
      'Stop this turn',
    ]);
  });

  it('advises differently depending on whether another attempt could help', () => {
    const temporary = apiRecoveryQuestion(failure(), 'm', []).question;
    const terminal = apiRecoveryQuestion(failure({ transient: false }), 'm', []).question;
    expect(temporary).toContain('temporary');
    expect(terminal).toContain('does not look temporary');
  });

  // With no key for anything else there is nothing to switch to, and offering it would be a lie.
  it('leaves the switch out when there is nowhere to switch to', () => {
    expect(apiRecoveryQuestion(failure(), 'm', []).choices).toHaveLength(2);
  });
});

describe('reading the answer back', () => {
  const read = (answer: string): ReturnType<typeof readApiPlan> => readApiPlan(answer, OTHERS);

  it('takes the retry row, and the word on its own', () => {
    expect(read(`Retry automatically, up to ${API_RETRIES} times`)).toEqual({
      do: 'retry',
      times: API_RETRIES,
    });
    expect(read('retry')).toEqual({ do: 'retry', times: API_RETRIES });
  });

  it('finds a model wherever in the sentence it sits', () => {
    expect(read(switchChoice('gpt-5'))).toEqual({ do: 'switch', model: 'gpt-5' });
    expect(read('gemini-2.5-pro')).toEqual({ do: 'switch', model: 'gemini-2.5-pro' });
    expect(read('switch to GPT-5 please')).toEqual({ do: 'switch', model: 'gpt-5' });
  });

  // Both of these are the same decision: nobody said to spend more of the author's money.
  it('stops on the stop row, on silence, and on anything it cannot read', () => {
    expect(read('Stop this turn')).toEqual({ do: 'stop' });
    expect(read('   ')).toEqual({ do: 'stop' });
    expect(read('do the needful')).toEqual({ do: 'stop' });
    // A model nobody offered is not a model this host can build a backend for.
    expect(read('switch to llama-9')).toEqual({ do: 'stop' });
  });
});
