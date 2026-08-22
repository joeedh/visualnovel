/**
 * What each backend claims about its own cache figures. The claim is what a consumer gates a
 * cross-call comparison on, so it is asserted here rather than left to whoever reads the backend.
 */
import { CACHE_TTL_MS, createAnthropicChat, createGeminiChat } from '../index.js';

describe('declared cache reporting', () => {
  it('is billed on Anthropic, whose figures are lines on a bill', () => {
    const chat = createAnthropicChat('k', 'claude-opus-4-5');
    expect(chat.cacheReporting).toBe('billed');
    expect(chat.cacheTtlMs).toBe(CACHE_TTL_MS);
  });

  it('is estimated on Gemini, whose figures are a matched prefix', () => {
    const chat = createGeminiChat('k', 'gemini-2.5-flash');
    expect(chat.cacheReporting).toBe('estimated');
    // No TTL: an estimate is never compared across calls, so how long it lasts decides nothing
    expect(chat.cacheTtlMs).toBeUndefined();
  });
});
